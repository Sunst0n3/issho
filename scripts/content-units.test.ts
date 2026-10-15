// @vitest-environment node
// Units (content/units/u*.json, else content/units.json): the grammar partition, ceilings, core
// conversations and their vocabulary, capstones and the ready flags (scripts/lib/units.ts).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { rubyToPlain } from '../src/lib/ruby.ts';
import type { CoreWord, PreToken, RolePlay, UnitSpec, WordEntry } from '../src/lib/types.ts';
import { mergeContent, readContentSources } from './lib/content.ts';
import { toPreTokens, refCoverage } from './lib/pretoken.ts';
import { MIN_CAPSTONE_STRUCTURES, buildUnits, canDoReady, taskReady } from './lib/units.ts';
import { loadTokenizer, type RubyTokenizer } from './v2/tokenize.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const content = (kind: Parameters<typeof readContentSources>[1]) => {
  const set = readContentSources(`${ROOT}content`, kind, ROOT);
  return { set, ...mergeContent(kind, set.sources, set.v1) };
};

const grammar = content('grammar').data as { id: string; order: number }[];
const core = content('core-words').data as CoreWord[];
const rolePlays = content('roleplays').data as RolePlay[];
const unitsSource = content('units');
const grammarOrder = new Map(grammar.map((g) => [g.id, g.order]));
const coreIds = new Set(core.map((c) => c.id));
const result = buildUnits(unitsSource.data as unknown[], { grammarOrder, coreIds, rolePlayIds: new Set(rolePlays.map((r) => r.id)) });
const units: UnitSpec[] = result.units;

describe('content units', () => {
  it('validate with no errors', () => {
    expect(unitsSource.set.errors).toEqual([]);
    expect(unitsSource.errors).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(units.map((u) => u.id)).toEqual(units.map((_, i) => i + 1));
  });

  it('partition the grammar exactly once, in grammar order', () => {
    const taught = units.flatMap((u) => u.grammar);
    const byOrder = [...grammar].sort((a, b) => a.order - b.order).map((g) => g.id);
    expect(taught).toEqual(byOrder);
  });

  it('raise the core-word ceiling with every unit', () => {
    for (let i = 1; i < units.length; i++) expect(units[i].coreWordCeiling, `u${units[i].id}`).toBeGreaterThan(units[i - 1].coreWordCeiling);
  });

  it('name a core conversation each, and only those scripts are core conversations', () => {
    const named = units.map((u) => u.conversation);
    expect(new Set(named).size).toBe(units.length);
    for (const id of named) expect(rolePlays.some((r) => r.id === id), id).toBe(true);
    // The other scripts (the 14 upgraded v1 ones) are free role-plays, whatever unit they gate on.
    const free = rolePlays.filter((r) => !named.includes(r.id));
    expect(free.length).toBeGreaterThan(0);
  });

  it(`ask for at least ${MIN_CAPSTONE_STRUCTURES} capstone structures taught by the unit or earlier`, () => {
    const unitOf = new Map(units.flatMap((u) => u.grammar.map((g) => [g, u.id] as const)));
    for (const u of units) {
      expect(u.capstone.structures.length, `u${u.id}`).toBeGreaterThanOrEqual(MIN_CAPSTONE_STRUCTURES);
      for (const s of u.capstone.structures) expect(unitOf.get(s)!, `u${u.id} ${s}`).toBeLessThanOrEqual(u.id);
    }
  });

  it('target only core words and grammar that exist', () => {
    for (const u of units) {
      for (const t of u.task.targets) {
        const [kind, id] = t.split(':');
        expect(kind === 'core' ? coreIds.has(id) : grammarOrder.has(id), `u${u.id} ${t}`).toBe(true);
      }
    }
  });

  it('mark can-dos and tasks ready exactly when their material is complete', () => {
    for (const u of units) {
      for (const cd of u.canDos) {
        const { kind, material, questions, rubric } = cd.check;
        const complete = !!material.trim() && (kind === 'read' || kind === 'listen' ? questions.length >= 2 && questions.length <= 3 : (rubric?.length ?? 0) >= 2 && (rubric?.length ?? 0) <= 4);
        expect(cd.ready, cd.id).toBe(complete);
      }
      const t = u.task;
      expect(t.ready, t.id).toBe(!!t.goal && !!t.infoA && !!t.infoB && t.scripted.length >= 8 && ['polite', 'plain', 'mixed'].includes(t.register));
    }
  });
});

describe('ready flags', () => {
  const check = { kind: 'listen' as const, material: '「こんにちは。」', questions: [{ q: 'q', options: ['a', 'b'], answer: 0 }] };

  it('need material and 2–3 questions (read, listen) or 2–4 rubric items (speak, write)', () => {
    expect(canDoReady(check)).toBe(false);
    expect(canDoReady({ ...check, questions: [check.questions[0], check.questions[0]] })).toBe(true);
    expect(canDoReady({ ...check, material: ' ', questions: [check.questions[0], check.questions[0]] })).toBe(false);
    expect(canDoReady({ kind: 'speak', material: 'x', questions: [], rubric: ['a', 'b'] })).toBe(true);
    expect(canDoReady({ kind: 'write', material: 'x', questions: [], rubric: ['a', 'b', 'c', 'd', 'e'] })).toBe(false);
  });

  it('need a goal, both information halves, ≥ 8 scripted lines and a register for a task', () => {
    const line = { role: 'a' as const, jp: 'はい。', en: 'Yes.' };
    const task = { goal: 'g', infoA: 'a', infoB: 'b', scripted: Array(8).fill(line), register: 'polite' as const };
    expect(taskReady(task)).toBe(true);
    expect(taskReady({ ...task, infoB: '' })).toBe(false);
    expect(taskReady({ ...task, scripted: Array(7).fill(line) })).toBe(false);
  });

  it('publish an empty register as mixed with a warning, and flag a capstone with too few structures', () => {
    const unit = {
      id: 1, title: 't', titleJp: 't', level: 'A1', topic: 't', grammar: ['a'], coreWordCeiling: 10, canDos: [], conversation: '',
      task: { id: 'u01-task', canDo: '', goal: '', outcomeQuestion: '', roles: { a: '', b: '' }, infoA: '', infoB: '', targets: ['core:nope'], register: '', twist: '', scripted: [] },
      capstone: { title: 'c', brief: 'b', minLinesEach: 8, structures: ['a'] },
    };
    const r = buildUnits([unit], { grammarOrder: new Map([['a', 1]]), coreIds: new Set(), rolePlayIds: null });
    expect(r.units[0].task.register).toBe('mixed');
    expect(r.warnings).toContain('u01: task register is empty; published as "mixed"');
    expect(r.warnings).toContain('u01: no core conversation');
    expect(r.errors).toEqual(['u01: task target "core:nope" does not exist', 'u01: capstone has 1 structures (at least 6)']);
  });

  it('fail on two units with one id in the same file', () => {
    const unit = (id: number, grammar: string, coreWordCeiling: number) => ({
      id, title: 't', titleJp: 't', level: 'A1', topic: 't', grammar: [grammar], coreWordCeiling, canDos: [], conversation: 'rp',
      task: { id: `u${id}-task`, canDo: '', goal: 'g', outcomeQuestion: '', roles: { a: '', b: '' }, infoA: 'a', infoB: 'b', targets: [], register: 'polite', twist: '', scripted: [] },
      capstone: { title: 'c', brief: 'b', minLinesEach: 8, structures: ['a', 'a', 'a', 'a', 'a', 'a'] },
    });
    const ctx = { grammarOrder: new Map([['a', 1], ['b', 2]]), coreIds: new Set<string>(), rolePlayIds: new Set(['rp']) };
    expect(buildUnits([unit(1, 'a', 10), unit(2, 'b', 20)], ctx).errors).toEqual([]);
    expect(buildUnits([unit(1, 'a', 10), unit(1, 'b', 20)], ctx).errors).toEqual(['u01: duplicate unit id 1']);

    // Can-do and task ids key the learner's records: one id in two units fails.
    const canDo = { id: 'u01-cd1', text: 't', check: { kind: 'read', instructions: '', material: '', questions: [] } };
    const second = { ...unit(2, 'b', 20), canDos: [canDo], task: { ...unit(1, 'a', 10).task } };
    expect(buildUnits([{ ...unit(1, 'a', 10), canDos: [canDo] }, second], ctx).errors).toEqual([
      'u02: can-do id "u01-cd1" is also used by u01',
      'u02: task id "u1-task" is also used by u01',
    ]);
  });
});

describe('core conversations', () => {
  let tk: RubyTokenizer;
  let links = new Map<string, string>();
  beforeAll(async () => {
    const wordsPath = `${ROOT}public/data/words.json`;
    const words = existsSync(wordsPath) ? (JSON.parse(readFileSync(wordsPath, 'utf8')) as WordEntry[]) : null;
    if (words) links = new Map(words.flatMap((w) => (w.core ? [[w.id, w.core] as const] : [])));
    tk = await loadTokenizer({ core, words });
  }, 30_000);

  it("use only their unit's core words or earlier (names excepted)", () => {
    const coreOrder = new Map(core.map((c) => [c.id, c.order]));
    const problems: string[] = [];
    for (const u of units) {
      const rp = rolePlays.find((r) => r.id === u.conversation)!;
      const names = [rp.roles.a.nameJp, rp.roles.b.nameJp].map(rubyToPlain);
      const tokens: PreToken[] = rp.lines.flatMap((l) => toPreTokens(tk.tokenize(l.jp), links));
      // Role names (エマ, たなか) are names wherever they appear.
      for (const t of tokens) if (names.includes(t.s)) t.name = true;
      const cov = refCoverage(tokens, coreOrder, u.coreWordCeiling);
      if (cov.ratio < 1) {
        const outside = tokens
          .filter((t) => t.k === 'c' && !t.name && !(t.ref?.startsWith('core:') && coreOrder.get(t.ref.slice(5))! <= u.coreWordCeiling))
          .map((t) => t.s);
        if (outside.length > 0) problems.push(`${rp.id}: ${outside.join(' ')}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
