// Role-plays (content/roleplays-v2/*.json; else content/roleplays-v2.json; else v1
// content/roleplays.json, upgraded): structural checks, target checks and the published order.
// A core conversation is a script that some UnitSpec.conversation names; nothing else is.

import type { RolePlay, RolePlayLine, TargetRef } from '../../src/lib/types.ts';
import { Checker, eachObject, isObj, labelOf, type ContentField, type ContentItem, type Obj } from './checker.ts';
import { SCRIPT_REGISTERS, unknownTargets } from './units.ts';

/** A core conversation outside this many lines is a warning. */
export const CORE_CONVERSATION_LINES = { min: 4, max: 8 } as const;

/**
 * Structural checks for role-play data (one RolePlay or an array). `v1` checks the old shape
 * (no register, targets or cues), which the build upgrades.
 */
export function checkRolePlays(data: unknown, c: Checker, v1 = false): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(Array.isArray(data) ? data : [data], c, 'role-plays', (r, i) => {
    const id = c.id(r, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    c.number(r, 'unit', where, true);
    c.string(r, 'title', where);
    c.ruby(r, 'titleJp', where, fields);
    c.oneOf(r, 'level', where, [1, 2, 3]);
    c.string(r, 'setting', where);
    if (!v1) {
      c.oneOf(r, 'register', where, SCRIPT_REGISTERS);
      c.strings(r, 'targets', where);
    }
    const roles = r.roles;
    if (!isObj(roles)) c.error(where, '"roles" must be an object with "a" and "b"');
    else {
      for (const key of ['a', 'b'] as const) {
        const role = roles[key];
        const at = `${where}.roles.${key}`;
        if (!isObj(role)) {
          c.error(at, 'must be an object');
          continue;
        }
        c.string(role, 'name', at);
        c.ruby(role, 'nameJp', at, fields);
      }
    }
    const lines = c.array(r, 'lines', where);
    if (lines.length === 0) c.error(where, 'has no lines');
    lines.forEach((line, j) => {
      const at = `${where}.lines[${j}]`;
      if (!isObj(line)) return c.error(at, 'must be an object');
      c.oneOf(line, 'role', at, ['a', 'b']);
      c.ruby(line, 'jp', at, fields);
      c.string(line, 'en', at);
      c.string(line, 'hint', at, true);
      if (!v1) c.text(line, 'cue', at);
    });
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A RolePlay in the published key order; a v1 script gets `cue: ''`, `targets: []` and `register: 'mixed'`. */
export function toRolePlay(r: Obj, v1 = false): RolePlay {
  const roles = (isObj(r.roles) ? r.roles : {}) as Record<string, Obj>;
  const role = (k: 'a' | 'b') => ({ name: str(roles[k]?.name), nameJp: str(roles[k]?.nameJp) });
  const out: RolePlay = { id: str(r.id) } as RolePlay;
  if (typeof r.unit === 'number') out.unit = r.unit;
  out.title = str(r.title);
  out.titleJp = str(r.titleJp);
  out.setting = str(r.setting);
  out.level = r.level as RolePlay['level'];
  out.register = v1 ? 'mixed' : (r.register as RolePlay['register']);
  out.targets = v1 || !Array.isArray(r.targets) ? [] : (r.targets.filter((t) => typeof t === 'string') as TargetRef[]);
  out.roles = { a: role('a'), b: role('b') };
  out.lines = (Array.isArray(r.lines) ? r.lines : []).filter(isObj).map((l) => {
    const line: RolePlayLine = { role: l.role as 'a' | 'b', jp: str(l.jp), en: str(l.en) } as RolePlayLine;
    if (typeof l.hint === 'string' && l.hint) line.hint = l.hint;
    line.cue = v1 ? '' : str(l.cue);
    return line;
  });
  return out;
}

export interface RolePlayContext {
  grammarOrder: ReadonlyMap<string, number>;
  coreIds: ReadonlySet<string>;
  /** Role-play id → the unit whose `conversation` names it. */
  conversations: ReadonlyMap<string, number>;
}

/**
 * The published role-plays: core conversations first (by the unit that names them), then the free
 * role-plays by id. Unknown targets are errors; an empty cue and a core conversation outside 4–8
 * lines are warnings. Ids were checked for duplicates when the source was read.
 */
export function buildRolePlays(
  raw: readonly unknown[],
  ctx: RolePlayContext,
  v1 = false,
): { rolePlays: RolePlay[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rolePlays = raw.filter(isObj).map((r) => toRolePlay(r, v1));
  for (const rp of rolePlays) {
    for (const bad of unknownTargets(rp.targets, ctx)) errors.push(`${rp.id}: target "${bad}" does not exist`);
    if (!v1) {
      const empty = rp.lines.filter((l) => !l.cue.trim()).length;
      if (empty > 0) warnings.push(`${rp.id}: ${empty} line(s) have no cue`);
    }
    if (ctx.conversations.has(rp.id)) {
      const n = rp.lines.length;
      if (n < CORE_CONVERSATION_LINES.min || n > CORE_CONVERSATION_LINES.max) {
        warnings.push(`${rp.id}: core conversation has ${n} lines (${CORE_CONVERSATION_LINES.min}–${CORE_CONVERSATION_LINES.max} expected)`);
      }
    }
  }
  const rank = (rp: RolePlay) => ctx.conversations.get(rp.id) ?? Infinity;
  rolePlays.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rolePlays, errors, warnings };
}
