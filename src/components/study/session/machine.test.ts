// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { KanaRule } from '../../../lib/types.ts';
import type { NewItemPlan } from '../../../srs/course.ts';
import type { DayPlan } from '../../../srs/planner.ts';
import { seededRandom } from '../../../srs/random.ts';
import {
  canRetrieve,
  firstCheckIds,
  initialSession,
  MAX_DAY0_RETRIEVALS,
  sessionReducer,
  sessionSteps,
  sittingTaught,
  stepLabel,
  type LearnedItem,
  type SessionState,
} from './machine.ts';

const item = (kind: NewItemPlan['kind'], key: string, extra: Partial<NewItemPlan> = {}): NewItemPlan => ({
  itemId: `${kind === 'staged' ? 'word' : kind}:${key}`,
  kind,
  key,
  priceSec: 35,
  stream: kind === 'kana' || kind === 'kanaRule' ? 'sprint' : kind === 'staged' ? 'staged' : kind,
  ...extra,
});

function plan(over: Partial<DayPlan> = {}): DayPlan {
  return {
    day: '2026-10-15',
    courseDay: 20,
    mode: 'normal',
    sitting: 'any',
    budgetMin: 25,
    estimateMin: 20,
    partOfDayDone: false,
    tomorrowMin: 18,
    strandMin: 4,
    warmup: ['kana:あ|read', 'kanji:日|write'],
    bury: [],
    teach: [
      { items: [item('kanji', '水', { anchor: 'word:1' }), item('core', 'cw-0001'), item('grammar', 'wa-desu')] },
      { items: [item('staged', '2', { kanji: '水' }), item('grammar', 'ka-question')] },
    ],
    pendingCheck: [],
    read: { kind: 'sentences', kanaWords: [], sentences: [{ id: 's1', target: 'core:cw-0001' }], minutes: 3 },
    output: { target: { ref: 'core:cw-0001', label: 'もう', en: 'already' } },
    fluency: { kind: 'speed' },
    doneSteps: [],
    counts: { reviews: 2, newItems: 5 },
    brake: false,
    offerExtraKanji: false,
    paperAllowed: true,
    courseComplete: false,
    ...over,
  };
}

const ids = (p: DayPlan) => sessionSteps(p).map((s) => (s.batch === undefined ? s.id : `${s.id}${s.batch}`));

describe('sessionSteps', () => {
  it('orders warm-up → (teach, memory) per batch → read → check → output → fluency → summary', () => {
    expect(ids(plan())).toEqual(['warmup', 'teach0', 'memory0', 'teach1', 'read', 'check', 'output', 'fluency', 'summary']);
  });

  it('gives a batch a memory step only when it has a kanji, sprint kana or core word', () => {
    const sprint = plan({
      mode: 'sprint',
      warmup: [],
      teach: [
        { items: ['あ', 'い', 'う', 'え', 'お'].map((k) => item('kana', k)) },
        { items: [item('kanaRule', 'hira-dakuten')] },
        { items: [item('core', 'cw-0002')] },
      ],
      output: null,
      fluency: null,
    });
    expect(ids(sprint)).toEqual(['teach0', 'memory0', 'teach1', 'teach2', 'memory2', 'read', 'check', 'summary']);
  });

  it('runs an anywhere sitting as warm-up → summary', () => {
    expect(ids(plan({ sitting: 'anywhere' }))).toEqual(['warmup', 'summary']);
  });

  it('runs micro and welcome-back sessions as warm-up → summary', () => {
    expect(ids(plan({ mode: 'micro' }))).toEqual(['warmup', 'summary']);
    expect(ids(plan({ mode: 'welcome-back' }))).toEqual(['warmup', 'summary']);
  });

  it('keeps a make-up to its review-ahead, reading and speed round', () => {
    expect(ids(plan({ mode: 'makeup' }))).toEqual(['warmup', 'read', 'fluency', 'summary']);
  });

  it('skips read, output and fluency already done today', () => {
    expect(ids(plan({ doneSteps: ['read', 'output', 'fluency'] }))).toEqual(['warmup', 'teach0', 'memory0', 'teach1', 'check', 'summary']);
  });

  it('includes a step only when the plan has content for it', () => {
    expect(ids(plan({ warmup: [], teach: [], read: null, output: null, fluency: null }))).toEqual(['summary']);
    // Nothing taught, but New cards left unchecked by an earlier sitting: the check still runs.
    expect(ids(plan({ warmup: [], teach: [{ items: [] }], read: null, output: null, fluency: null, pendingCheck: ['core:cw-0009|listen'] })))
      .toEqual(['check', 'summary']);
  });

  it('labels steps by name', () => {
    const p = plan();
    expect(sessionSteps(p).map((s) => stepLabel(s, p))).toEqual(
      ['Warm-up', 'New 1 / 2', 'Memory', 'New 2 / 2', 'Read', 'Check', 'Sentence', 'Fluency', 'Done'],
    );
  });
});

const kanji: LearnedItem = {
  plan: item('kanji', '水', { anchor: 'word:1' }),
  itemIds: ['kanji:水', 'word:1'],
  cardIds: ['kanji:水|write', 'word:1|read'],
  memoryCardId: 'kanji:水|write',
};
const core: LearnedItem = {
  plan: item('core', 'cw-0001'),
  itemIds: ['core:cw-0001'],
  cardIds: ['core:cw-0001|listen', 'core:cw-0001|produce'],
  memoryCardId: 'core:cw-0001|produce',
};
const grammar: LearnedItem = {
  plan: item('grammar', 'wa-desu'),
  itemIds: ['grammar:wa-desu'],
  cardIds: ['grammar:wa-desu|comprehend', 'grammar:wa-desu|build'],
};

describe('firstCheckIds', () => {
  it('puts production cards first, then the rest, and includes every pendingCheck card once', () => {
    const pending = ['core:cw-0001|listen', 'kana:あ|read', 'kana:あ|write'];
    const out = firstCheckIds([kanji, core, grammar], pending, seededRandom(3));
    expect(out).toHaveLength(8);
    expect(new Set(out).size).toBe(8);
    expect(new Set(out.slice(0, 4))).toEqual(new Set(['kanji:水|write', 'core:cw-0001|produce', 'grammar:wa-desu|build', 'kana:あ|write']));
    expect(new Set(out.slice(4))).toEqual(new Set(['word:1|read', 'core:cw-0001|listen', 'grammar:wa-desu|comprehend', 'kana:あ|read']));
  });

  it('shuffles within each group with the given random', () => {
    const many: LearnedItem[] = Array.from({ length: 8 }, (_, i) => ({
      plan: item('kana', `k${i}`), itemIds: [`kana:k${i}`], cardIds: [`kana:k${i}|write`, `kana:k${i}|read`], memoryCardId: `kana:k${i}|write`,
    }));
    const a = firstCheckIds(many, [], seededRandom(1));
    const b = firstCheckIds(many, [], seededRandom(2));
    expect(a).not.toEqual(b);
    expect(a.slice(0, 8).every((id) => id.endsWith('|write'))).toBe(true);
  });
});

describe('firstCheckIds: write cards first (V022, V039)', () => {
  it('asks every write card before the produce, build and cloze cards, then the rest', () => {
    const anchor: LearnedItem = {
      plan: item('core', 'cw-0215'), itemIds: ['core:cw-0215'], cardIds: ['core:cw-0215|produce', 'core:cw-0215|read'], memoryCardId: 'core:cw-0215|produce',
    };
    const one: LearnedItem = { plan: item('kanji', '一'), itemIds: ['kanji:一'], cardIds: ['kanji:一|write'], memoryCardId: 'kanji:一|write' };
    for (let seed = 1; seed <= 20; seed++) {
      const out = firstCheckIds([anchor, one, grammar], [], seededRandom(seed));
      expect(out[0]).toBe('kanji:一|write');
      expect(new Set(out.slice(1, 3))).toEqual(new Set(['core:cw-0215|produce', 'grammar:wa-desu|build']));
    }
  });
});

describe('sittingTaught (V019)', () => {
  const rules: KanaRule[] = [{ id: 'hira-dakuten', day: 6, script: 'hiragana', title: '', explanation: '', pairs: [{ from: 'か', to: 'が', romaji: 'ga' }], practiceWords: [] }];
  const before = new Set(['あ']);

  it('adds the kana and rules taught so far in the sitting, and the item whose lesson is on screen', () => {
    const learned = [{ itemIds: ['kana:い'] }, { itemIds: ['kanaRule:hira-dakuten'] }];
    expect([...sittingTaught(before, learned, undefined, rules)].sort()).toEqual(['あ', 'い', 'が'].sort());
    expect([...sittingTaught(before, [], { itemId: 'kana:う' }, rules)].sort()).toEqual(['あ', 'う']);
    expect([...sittingTaught(before, [], { itemId: 'kanaRule:hira-dakuten' }, rules)].sort()).toEqual(['あ', 'が']);
  });

  it('keeps the same set when the sitting adds no kana', () => {
    expect(sittingTaught(before, [{ itemIds: ['kanji:水', 'word:w'] }], { itemId: 'kana:あ' }, rules)).toBe(before);
  });
});

describe('sessionReducer', () => {
  const start = () => initialSession(plan());

  it('moves through the steps and stops at the summary', () => {
    let s = start();
    for (let i = 0; i < 20; i++) s = sessionReducer(s, { type: 'next' });
    expect(s.steps[s.index].id).toBe('summary');
  });

  it('records each taught item once', () => {
    let s = sessionReducer(start(), { type: 'taught', item: kanji });
    s = sessionReducer(s, { type: 'taught', item: kanji });
    s = sessionReducer(s, { type: 'taught', item: core });
    expect(s.learned.map((l) => l.plan.itemId)).toEqual(['kanji:水', 'core:cw-0001']);
  });

  it('fixes the check ids when the check starts', () => {
    let s = sessionReducer(start(), { type: 'start-check', ids: ['a|write'] });
    s = sessionReducer(s, { type: 'start-check', ids: ['b|write'] });
    expect(s.checkIds).toEqual(['a|write']);
  });

  it('counts retrievals per card, never above 4', () => {
    const retrieve = (s: SessionState, cardId: string) => sessionReducer(s, { type: 'retrieved', cardId });
    let s = start();
    // Kanji: the memory pass counts for its write card, a reading appearance for its anchor's read card.
    s = retrieve(s, kanji.memoryCardId!);
    s = retrieve(s, 'word:1|read');
    expect(s.retrievals).toEqual({ 'kanji:水|write': 1, 'word:1|read': 1 });
    // Each card still gets its first check and one re-ask.
    for (const id of kanji.cardIds) {
      expect(canRetrieve(s, id)).toBe(true);
      s = retrieve(s, id);
      expect(canRetrieve(s, id)).toBe(true);
      s = retrieve(s, id);
    }
    expect(s.retrievals).toEqual({ 'kanji:水|write': 3, 'word:1|read': 3 });
    s = retrieve(s, 'word:1|read');
    expect(s.retrievals['word:1|read']).toBe(MAX_DAY0_RETRIEVALS);
    expect(canRetrieve(s, 'word:1|read')).toBe(false);
    const capped = retrieve(s, 'word:1|read');
    expect(capped).toBe(s);
    expect(capped.retrievals['word:1|read']).toBe(4);
  });
});
