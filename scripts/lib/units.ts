// Units (content/units/u*.json, or content/units.json): structural checks, cross-checks against
// grammar, core words and role-plays, and the `ready` flags that keep unfinished can-do checks and
// tasks out of the app.

import type { CanDo, CanDoCheckKind, TaskCard, TargetRef, UnitSpec } from '../../src/lib/types.ts';
import { Checker, eachObject, isObj, labelOf, type ContentField, type ContentItem, type Obj } from './checker.ts';

export const UNIT_LEVELS: readonly UnitSpec['level'][] = ['A1', 'A2', 'N3-path'];
export const CANDO_KINDS: readonly CanDoCheckKind[] = ['read', 'listen', 'speak', 'write'];
export const SCRIPT_REGISTERS: readonly TaskCard['register'][] = ['polite', 'plain', 'mixed'];
/** A capstone asks for at least this many grammar structures. */
export const MIN_CAPSTONE_STRUCTURES = 6;
/** A task's offline script needs at least this many lines to be ready. */
export const MIN_TASK_LINES = 8;

function checkQuestions(list: unknown[], at: string, c: Checker): void {
  list.forEach((q, k) => {
    const where = `${at}.questions[${k}]`;
    if (!isObj(q)) return c.error(where, 'must be an object');
    c.string(q, 'q', where);
    const options = c.strings(q, 'options', where);
    if (options.length < 2) c.error(where, 'needs at least 2 options');
    const answer = q.answer;
    if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
      c.error(where, `"answer" ${JSON.stringify(answer)} is not an index into its ${options.length} options`);
    }
  });
}

function checkLines(list: unknown[], at: string, c: Checker, fields: ContentField[]): void {
  list.forEach((line, k) => {
    const where = `${at}[${k}]`;
    if (!isObj(line)) return c.error(where, 'must be an object');
    c.oneOf(line, 'role', where, ['a', 'b']);
    c.ruby(line, 'jp', where, fields);
    c.string(line, 'en', where);
  });
}

/**
 * Structural checks for one unit file's data (a UnitSpec or an array of them). Material, questions,
 * rubrics, task halves and scripts may still be empty: that only clears `ready`.
 */
export function checkUnits(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(Array.isArray(data) ? data : [data], c, 'units', (u, i) => {
    const id = c.number(u, 'id', `[${i}]`);
    const where = labelOf(i, id === undefined ? undefined : `u${String(id).padStart(2, '0')}`);
    const fields: ContentField[] = [];
    if (id !== undefined && (!Number.isInteger(id) || id < 1)) c.error(where, '"id" must be a whole number from 1');
    c.string(u, 'title', where);
    c.ruby(u, 'titleJp', where, fields);
    c.oneOf(u, 'level', where, UNIT_LEVELS);
    c.string(u, 'topic', where);
    c.strings(u, 'grammar', where);
    const ceiling = c.number(u, 'coreWordCeiling', where);
    if (ceiling !== undefined && (!Number.isInteger(ceiling) || ceiling < 1)) c.error(where, '"coreWordCeiling" must be a whole number from 1');
    const canDoIds = new Set<string>();
    c.array(u, 'canDos', where).forEach((cd, k) => {
      const at = `${where}.canDos[${k}]`;
      if (!isObj(cd)) return c.error(at, 'must be an object');
      const cdId = c.string(cd, 'id', at);
      if (cdId !== undefined) {
        if (canDoIds.has(cdId)) c.error(at, `duplicate can-do id "${cdId}"`);
        canDoIds.add(cdId);
      }
      c.string(cd, 'text', at);
      const check = c.object(cd, 'check', at);
      if (!check) return;
      c.oneOf(check, 'kind', `${at}.check`, CANDO_KINDS);
      c.text(check, 'instructions', `${at}.check`);
      const material = c.text(check, 'material', `${at}.check`);
      if (material) c.ruby(check, 'material', `${at}.check`, fields);
      checkQuestions(c.array(check, 'questions', `${at}.check`), `${at}.check`, c);
      if (check.rubric !== undefined) c.strings(check, 'rubric', `${at}.check`);
    });
    c.text(u, 'conversation', where);
    const task = c.object(u, 'task', where);
    if (task) {
      const at = `${where}.task`;
      c.string(task, 'id', at);
      c.text(task, 'canDo', at);
      for (const key of ['goal', 'outcomeQuestion', 'infoA', 'infoB', 'twist', 'register']) c.text(task, key, at);
      const roles = c.object(task, 'roles', at);
      if (roles) for (const r of ['a', 'b']) c.text(roles, r, `${at}.roles`);
      c.strings(task, 'targets', at);
      c.string(task, 'aiRole', at, true);
      checkLines(c.array(task, 'scripted', at), `${at}.scripted`, c, fields);
    }
    const capstone = c.object(u, 'capstone', where);
    if (capstone) {
      const at = `${where}.capstone`;
      c.string(capstone, 'title', at);
      c.string(capstone, 'brief', at);
      c.number(capstone, 'minLinesEach', at);
      c.strings(capstone, 'structures', at);
    }
    items.push({ id: id === undefined ? String(i) : `u${String(id).padStart(2, '0')}`, where, fields });
  });
  return items;
}

/** A can-do check can be awarded: it has material, and 2–3 questions (read, listen) or 2–4 rubric items (speak, write). */
export function canDoReady(check: Pick<CanDo['check'], 'kind' | 'material' | 'questions' | 'rubric'>): boolean {
  if (!check.material?.trim()) return false;
  if (check.kind === 'read' || check.kind === 'listen') return check.questions.length >= 2 && check.questions.length <= 3;
  const rubric = check.rubric ?? [];
  return rubric.length >= 2 && rubric.length <= 4;
}

/** A task can run: goal, both information halves, ≥ 8 scripted lines and a valid register. */
export function taskReady(task: Pick<TaskCard, 'goal' | 'infoA' | 'infoB' | 'scripted' | 'register'>): boolean {
  return (
    !!task.goal.trim() &&
    !!task.infoA.trim() &&
    !!task.infoB.trim() &&
    task.scripted.length >= MIN_TASK_LINES &&
    SCRIPT_REGISTERS.includes(task.register)
  );
}

export interface UnitContext {
  /** grammar-v2 id → order. */
  grammarOrder: ReadonlyMap<string, number>;
  coreIds: ReadonlySet<string>;
  /** Ids of the role-plays that will ship (null when unknown: conversations are not checked). */
  rolePlayIds: ReadonlySet<string> | null;
}

export interface UnitsResult {
  units: UnitSpec[];
  errors: string[];
  warnings: string[];
}

/** Errors for `core:`/`grammar:` targets that do not exist. */
export function unknownTargets(targets: readonly string[], ctx: Pick<UnitContext, 'grammarOrder' | 'coreIds'>): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const [kind, id = ''] = t.split(/:(.*)/s);
    if (kind === 'core' ? !ctx.coreIds.has(id) : kind === 'grammar' ? !ctx.grammarOrder.has(id) : true) out.push(t);
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function toCanDo(cd: Obj): CanDo {
  const check = (isObj(cd.check) ? cd.check : {}) as Obj;
  const out: CanDo['check'] = {
    kind: check.kind as CanDoCheckKind,
    instructions: str(check.instructions),
    material: str(check.material),
    questions: (Array.isArray(check.questions) ? check.questions : []).filter(isObj).map((q) => ({
      q: str(q.q),
      options: strs(q.options),
      answer: Number(q.answer),
    })),
  };
  if (check.rubric !== undefined) out.rubric = strs(check.rubric);
  return { id: str(cd.id), text: str(cd.text), check: out, ready: canDoReady(out) };
}

/**
 * UnitSpec[] by id, with `ready` flags, from units that passed checkUnits. Cross-checks: unit ids,
 * can-do ids and task ids are unique; the units partition the grammar ids exactly once and in
 * `order`; `coreWordCeiling` strictly increases; task
 * targets and capstone structures exist (structures from this unit or earlier, at least 6). A
 * missing core conversation, a task naming another unit's can-do and an empty register (published
 * as 'mixed') are warnings.
 */
export function buildUnits(raw: readonly unknown[], ctx: UnitContext): UnitsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const list = raw.filter(isObj).sort((a, b) => Number(a.id) - Number(b.id));
  const units: UnitSpec[] = [];
  const grammarUnit = new Map<string, number>();
  const taught: string[] = [];
  const seen = new Set<number>();
  // Can-do and task ids key the learner's records (CanDoRecord), so they are unique across units
  // (checkUnits reports a repeat inside one unit).
  const ownerOf = new Map<string, string>();
  const claim = (id: string, what: string, tag: string) => {
    if (!id) return;
    const other = ownerOf.get(`${what}:${id}`);
    if (other === undefined) ownerOf.set(`${what}:${id}`, tag);
    else if (other !== tag) errors.push(`${tag}: ${what} id "${id}" is also used by ${other}`);
  };
  let lastCeiling = 0;

  for (const u of list) {
    const id = Number(u.id);
    const tag = `u${String(id).padStart(2, '0')}`;
    // Two files with one id are caught when the files are merged; two entries of one file here.
    if (seen.has(id)) errors.push(`${tag}: duplicate unit id ${id}`);
    seen.add(id);
    const grammar = strs(u.grammar);
    for (const g of grammar) {
      if (!ctx.grammarOrder.has(g)) errors.push(`${tag}: grammar "${g}" is not in grammar-v2`);
      else if (grammarUnit.has(g)) errors.push(`${tag}: grammar "${g}" is also taught by u${String(grammarUnit.get(g)).padStart(2, '0')}`);
      else grammarUnit.set(g, id);
      taught.push(g);
    }
    const ceiling = Number(u.coreWordCeiling);
    if (ceiling <= lastCeiling) errors.push(`${tag}: coreWordCeiling ${ceiling} must be above the previous unit's ${lastCeiling}`);
    lastCeiling = Math.max(lastCeiling, ceiling);

    const canDos = (Array.isArray(u.canDos) ? u.canDos : []).filter(isObj).map(toCanDo);
    for (const cd of canDos) claim(cd.id, 'can-do', tag);
    for (const cd of canDos) if (!cd.ready) warnings.push(`${tag}: can-do ${cd.id} is not ready (${cd.check.kind} check needs material and ${cd.check.kind === 'read' || cd.check.kind === 'listen' ? '2–3 questions' : '2–4 rubric items'})`);

    const conversation = str(u.conversation);
    if (!conversation) warnings.push(`${tag}: no core conversation`);
    else if (ctx.rolePlayIds && !ctx.rolePlayIds.has(conversation)) warnings.push(`${tag}: core conversation "${conversation}" is not a role-play`);

    const t = (isObj(u.task) ? u.task : {}) as Obj;
    let register = str(t.register) as TaskCard['register'];
    if (register === ('' as string)) {
      warnings.push(`${tag}: task register is empty; published as "mixed"`);
      register = 'mixed';
    } else if (!SCRIPT_REGISTERS.includes(register)) {
      errors.push(`${tag}: task register "${register}" must be polite, plain or mixed`);
    }
    const targets = strs(t.targets);
    for (const bad of unknownTargets(targets, ctx)) errors.push(`${tag}: task target "${bad}" does not exist`);
    const roles = (isObj(t.roles) ? t.roles : {}) as Obj;
    const task: TaskCard = {
      id: str(t.id),
      canDo: str(t.canDo),
      goal: str(t.goal),
      outcomeQuestion: str(t.outcomeQuestion),
      roles: { a: str(roles.a), b: str(roles.b) },
      infoA: str(t.infoA),
      infoB: str(t.infoB),
      targets: targets as TargetRef[],
      register,
      twist: str(t.twist),
      ...(typeof t.aiRole === 'string' && t.aiRole ? { aiRole: t.aiRole } : {}),
      scripted: (Array.isArray(t.scripted) ? t.scripted : []).filter(isObj).map((l) => ({
        role: l.role as 'a' | 'b',
        jp: str(l.jp),
        en: str(l.en),
      })),
      ready: false,
    };
    task.ready = taskReady(task);
    claim(task.id, 'task', tag);
    if (!task.ready) warnings.push(`${tag}: task ${task.id} is not ready (goal, info halves, ≥ ${MIN_TASK_LINES} scripted lines)`);
    if (task.canDo && !canDos.some((cd) => cd.id === task.canDo)) warnings.push(`${tag}: task can-do "${task.canDo}" is not one of the unit's can-dos`);

    const cap = (isObj(u.capstone) ? u.capstone : {}) as Obj;
    const structures = strs(cap.structures);
    if (structures.length < MIN_CAPSTONE_STRUCTURES) errors.push(`${tag}: capstone has ${structures.length} structures (at least ${MIN_CAPSTONE_STRUCTURES})`);
    for (const s of structures) {
      if (!ctx.grammarOrder.has(s)) errors.push(`${tag}: capstone structure "${s}" is not in grammar-v2`);
      else if ((grammarUnit.get(s) ?? Infinity) > id && !grammar.includes(s)) errors.push(`${tag}: capstone structure "${s}" is taught after this unit`);
    }

    units.push({
      id,
      title: str(u.title),
      titleJp: str(u.titleJp),
      level: u.level as UnitSpec['level'],
      topic: str(u.topic),
      grammar,
      coreWordCeiling: ceiling,
      canDos,
      conversation,
      task,
      capstone: { title: str(cap.title), brief: str(cap.brief), minLinesEach: Number(cap.minLinesEach), structures },
    });
  }

  if (units.length > 0) {
    const expected = [...ctx.grammarOrder].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const missing = expected.filter((g) => !grammarUnit.has(g));
    if (missing.length > 0) errors.push(`units teach no unit for grammar ${missing.join(', ')}`);
    const inUnits = taught.filter((g) => ctx.grammarOrder.has(g));
    const outOfOrder = inUnits.findIndex((g, i) => i > 0 && ctx.grammarOrder.get(g)! < ctx.grammarOrder.get(inUnits[i - 1])!);
    if (outOfOrder > 0) {
      errors.push(`units teach grammar out of order: "${inUnits[outOfOrder]}" (#${ctx.grammarOrder.get(inUnits[outOfOrder])}) comes after "${inUnits[outOfOrder - 1]}" (#${ctx.grammarOrder.get(inUnits[outOfOrder - 1])})`);
    }
  }
  return { units, errors, warnings };
}

/** grammar id → the unit that teaches it. */
export function grammarUnits(units: readonly Pick<UnitSpec, 'id' | 'grammar'>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of units) for (const g of u.grammar) if (!out.has(g)) out.set(g, u.id);
  return out;
}
