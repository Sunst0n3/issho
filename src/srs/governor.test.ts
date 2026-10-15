import { describe, expect, it } from 'vitest';
import type { DailyMinutes, StreamSeconds } from '../lib/types.ts';
import { courseGates, type NewItemPlan, type StreamCandidates } from './course.ts';
import {
  forecastSeconds,
  govern,
  PRICE_SEC,
  reviewSeconds,
  strandMinutes,
  type GovDueCard,
  type GovernorInput,
  type GovernorOutput,
  type GovToday,
  type SharedStream,
} from './governor.ts';
import { seededRandom } from './random.ts';
import { DEFAULT_SECONDS, type TimingKey } from './timing.ts';

const zeroSec = (): StreamSeconds => ({ sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 });
const emptyToday = (patch: Partial<GovToday> = {}): GovToday => ({
  kanji: 0, core: 0, staged: 0, grammar: 0, newSec: zeroSec(), reviewSec: 0, strandSec: 0, catchUp: false, ...patch,
});

let serial = 0;
function kanji(anchor = true): NewItemPlan {
  const n = serial++;
  return {
    itemId: `kanji:k${n}`, kind: 'kanji', key: `k${n}`, anchor: anchor ? `word:${n}` : null,
    priceSec: PRICE_SEC.kanji + (anchor ? PRICE_SEC.anchor : 0), stream: 'kanji',
  };
}
const core = (): NewItemPlan => {
  const n = serial++;
  return { itemId: `core:c${n}`, kind: 'core', key: `c${n}`, priceSec: PRICE_SEC.core, stream: 'core' };
};
const grammar = (): NewItemPlan => {
  const n = serial++;
  return { itemId: `grammar:g${n}`, kind: 'grammar', key: `g${n}`, priceSec: PRICE_SEC.grammar, stream: 'grammar' };
};
const staged = (): NewItemPlan => {
  const n = serial++;
  return { itemId: `word:s${n}`, kind: 'staged', key: `s${n}`, kanji: 'x', priceSec: PRICE_SEC.staged, stream: 'staged' };
};
const kana = (): NewItemPlan => {
  const n = serial++;
  return { itemId: `kana:${n}`, kind: 'kana', key: String(n), priceSec: PRICE_SEC.kana, stream: 'sprint' };
};
const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

function candidates(patch: Partial<StreamCandidates> = {}): StreamCandidates {
  return {
    kana: [], kanaRule: null, kanji: times(4, () => kanji()), core: times(3, core), grammar: grammar(),
    grammarBelowFloor: false, staged: [], ...patch,
  };
}

/** n due cards of one key at retrievability r (seconds each: s + (1 − r)(s + 8)). */
const due = (n: number, key: TimingKey, r = 1, value: 0 | 1 | 2 = 0): GovDueCard[] =>
  Array.from({ length: n }, () => ({ id: `card${serial++}`, key, r, value }));

function input(patch: Partial<GovernorInput> = {}): GovernorInput {
  return {
    budgetMin: 25,
    courseDay: 20,
    gates: courseGates({}),
    sprintComplete: true,
    wordsKnown: 100,
    seconds: DEFAULT_SECONDS,
    due: [],
    upcoming: [],
    candidates: candidates(),
    spent14: { kanji: 0, core: 0, grammar: 0 },
    today: emptyToday(),
    accuracy3: null,
    accuracy7: null,
    underBudget7: false,
    catchUpBefore: false,
    travel: false,
    extraKanji: false,
    ...patch,
  };
}

const count = (out: GovernorOutput, stream: NewItemPlan['stream']) => out.newItems.filter((i) => i.stream === stream).length;
const cap = (budget: DailyMinutes) => 1.1 * budget * 60;

describe('strandMinutes', () => {
  it('grows from 2 to RMAX with the course day and the known words', () => {
    expect(strandMinutes(10, 0, 25)).toBe(2);
    expect(strandMinutes(30, 0, 25)).toBe(4);
    expect(strandMinutes(61, 500, 25)).toBe(6);
    expect(strandMinutes(61, 1300, 25)).toBe(8);
    expect(strandMinutes(61, 1300, 20)).toBe(6);
    expect(strandMinutes(61, 1300, 40)).toBe(10);
  });
});

describe('review and forecast seconds', () => {
  it('prices a miss as feedback plus a re-ask', () => {
    expect(reviewSeconds(due(2, 'listen', 0.5), DEFAULT_SECONDS)).toBeCloseTo(2 * (7 + 0.5 * 15));
    expect(forecastSeconds(['kanjiWrite', 'kanjiWrite'], DEFAULT_SECONDS)).toBeCloseTo((2 * 1.12 * 22) / 7);
  });
});

describe('govern', () => {
  it('(a) day 20, 25 min, nothing due: a full day of new items within 27.5 min, with a 188-s kanji', () => {
    const out = govern(input({ candidates: candidates({ staged: times(4, staged) }) }));
    expect(out.mode).toBe('normal');
    expect(out.seconds.newRoom).toBe(1200);
    expect(out.seconds.total).toBeLessThanOrEqual(1650);
    const kanjiItems = out.newItems.filter((i) => i.kind === 'kanji');
    expect(kanjiItems.length).toBeGreaterThanOrEqual(1);
    expect(kanjiItems[0]).toMatchObject({ priceSec: 188 });
    expect(kanjiItems[0].anchor).toBeTruthy();
    expect(out.seconds.newPlanned).toBeLessThanOrEqual(981);
    expect(out.strandMin).toBe(4);
  });

  it('(b) catch-up when the reviews exceed the budget: lowest r first, kept in warm-up order', () => {
    const cards = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, key: 'listen' as const, r: 0.3 + (i % 5) * 0.1, value: 0 as const }));
    expect(reviewSeconds(cards, DEFAULT_SECONDS)).toBeGreaterThan(1500);
    const out = govern(input({ due: cards }));
    expect(out.mode).toBe('catch-up');
    expect(out.newItems).toEqual([]);
    expect(out.strandMin).toBe(2);
    const chosen = new Set(out.reviews);
    expect(reviewSeconds(cards.filter((c) => chosen.has(c.id)), DEFAULT_SECONDS)).toBeLessThanOrEqual(1320);
    const maxChosen = Math.max(...cards.filter((c) => chosen.has(c.id)).map((c) => c.r));
    const minLeft = Math.min(...cards.filter((c) => !chosen.has(c.id)).map((c) => c.r));
    expect(maxChosen).toBeLessThanOrEqual(minLeft);
    expect(out.reviews).toEqual(cards.filter((c) => chosen.has(c.id)).map((c) => c.id));
    expect(out.seconds.dayTotal).toBeLessThanOrEqual(1320 + 120 + 1e-9);
  });

  it('(b2, m) hysteresis: after a catch-up day (or a fresh start) it stays in catch-up until the load is ≤ LF', () => {
    // LF = 1500 − 240 = 1260 on day 20.
    const between = due(130, 'comprehend'); // 1300 s
    const under = due(120, 'comprehend'); // 1200 s
    expect(govern(input({ due: between })).mode).toBe('normal');
    expect(govern(input({ due: between, catchUpBefore: true })).mode).toBe('catch-up');
    expect(govern(input({ due: under, catchUpBefore: true })).mode).toBe('normal');
  });

  it('(c, d) the accuracy brake halves the room', () => {
    const fine = govern(input({ accuracy3: 0.81 }));
    const braked = govern(input({ accuracy3: 0.79 }));
    expect(fine.brake).toBe(false);
    expect(braked.brake).toBe(true);
    expect(braked.seconds.newRoom).toBe(fine.seconds.newRoom / 2);
  });

  it('(e) below the weekly grammar floor, grammar goes ahead of kanji; never two points in a plan', () => {
    const out = govern(input({ candidates: candidates({ grammarBelowFloor: true }), spent14: { kanji: 0, core: 500, grammar: 500 } }));
    expect(out.newItems[0].kind).toBe('grammar');
    expect(count(out, 'grammar')).toBe(1);
    const normal = govern(input({ spent14: { kanji: 0, core: 500, grammar: 500 } }));
    expect(normal.newItems[0].kind).toBe('kanji');
    expect(count(normal, 'grammar')).toBeLessThanOrEqual(1);
  });

  /** Runs the governor for `days` days, feeding each day's new seconds back into spent14. */
  function run(days: number, perDay: (day: number) => Partial<GovernorInput>): { shares: Record<SharedStream, number>; outs: GovernorOutput[] } {
    const history: Record<SharedStream, number>[] = [];
    const outs: GovernorOutput[] = [];
    for (let d = 0; d < days; d++) {
      const spent14 = { kanji: 0, core: 0, grammar: 0 };
      for (const h of history.slice(-14)) {
        spent14.kanji += h.kanji;
        spent14.core += h.core;
        spent14.grammar += h.grammar;
      }
      const out = govern(input({ courseDay: 30, spent14, ...perDay(d) }));
      outs.push(out);
      const day = { kanji: 0, core: 0, grammar: 0 };
      for (const item of out.newItems) if (item.stream in day) day[item.stream as SharedStream] += item.priceSec;
      history.push(day);
    }
    const total = { kanji: 0, core: 0, grammar: 0 };
    for (const h of history) {
      total.kanji += h.kanji;
      total.core += h.core;
      total.grammar += h.grammar;
    }
    const sum = total.kanji + total.core + total.grammar;
    return { shares: { kanji: total.kanji / sum, core: total.core / sum, grammar: total.grammar / sum }, outs };
  }

  it('(f) room-limited days balance the streams near 60/20/20', () => {
    // Rv = 700 s (100 listen cards at r = 1) → NewRoom = 1260 − 700 − 60 = 500 s.
    const { shares, outs } = run(28, (d) => ({ due: due(100, 'listen'), candidates: candidates({ grammar: d % 2 === 0 ? grammar() : null }) }));
    expect(outs[0].seconds.newRoom).toBe(500);
    expect(shares.kanji).toBeGreaterThanOrEqual(0.5);
    expect(shares.kanji).toBeLessThanOrEqual(0.7);
    expect(shares.core).toBeGreaterThanOrEqual(0.1);
    expect(shares.core).toBeLessThanOrEqual(0.3);
    expect(shares.grammar).toBeGreaterThanOrEqual(0.1);
    expect(shares.grammar).toBeLessThanOrEqual(0.3);
  });

  it('(f2) ceiling-bound days: 3 kanji and 3 core every day, grammar every other day', () => {
    const { shares, outs } = run(28, (d) => ({ candidates: candidates({ grammar: d % 2 === 0 ? grammar() : null }) }));
    for (const [d, out] of outs.entries()) {
      expect(count(out, 'kanji')).toBe(3);
      expect(count(out, 'core')).toBe(3);
      expect(count(out, 'grammar')).toBe(d % 2 === 0 ? 1 : 0);
    }
    expect(shares.kanji).toBeCloseTo(0.73, 1);
    expect(shares.core).toBeCloseTo(0.14, 1);
    expect(shares.grammar).toBeCloseTo(0.13, 1);
  });

  it('(f3) staged words are their own stream and leave the shared streams alone', () => {
    const base = candidates();
    const without = govern(input({ candidates: base }));
    const withStaged = govern(input({ candidates: { ...base, staged: times(4, staged) } }));
    expect(withStaged.newItems.filter((i) => i.kind === 'staged').every((i) => i.stream === 'staged')).toBe(true);
    expect(count(withStaged, 'staged')).toBe(4);
    const shared = (out: GovernorOutput) => out.newItems.filter((i) => i.kind !== 'staged').map((i) => i.itemId);
    expect(shared(withStaged)).toEqual(shared(without));
  });

  it('(f4) a stream whose next item does not fit is closed: no later, cheaper kanji jumps ahead', () => {
    // Rv = 1030 s → NewRoom = 1260 − 1030 − 60 = 170 s.
    const out = govern(input({ due: due(103, 'comprehend'), candidates: candidates({ kanji: [kanji(true), kanji(false)], grammar: null }) }));
    expect(out.seconds.newRoom).toBe(170);
    expect(count(out, 'kanji')).toBe(0);
    expect(count(out, 'core')).toBe(3);
  });

  it('(g) hard cap and strand squeeze keep the day under 1.1 × budget', () => {
    const out = govern(input({ courseDay: 61, wordsKnown: 500, due: due(130, 'comprehend') }));
    expect(out.mode).toBe('normal');
    expect(out.newItems).toEqual([]);
    expect(out.strandMin).toBe(5);
    expect(out.seconds.total).toBeLessThanOrEqual(1650);
  });

  it('(h) sprint days are never throttled and never catch-up', () => {
    const sprintCandidates = candidates({ kana: times(10, kana), kanji: [], grammar: null });
    const day3 = govern(input({ courseDay: 3, sprintComplete: false, due: due(160, 'comprehend'), candidates: sprintCandidates }));
    expect(day3.mode).toBe('sprint');
    expect(count(day3, 'sprint')).toBe(10);
    expect(count(day3, 'core')).toBe(3);
    const day16 = govern(input({ courseDay: 16, sprintComplete: false, candidates: candidates({ kana: times(2, kana) }) }));
    expect(day16.mode).toBe('sprint');
    expect(count(day16, 'kanji')).toBe(0);
  });

  it('(h) sprint grammar waits when it would push the day over 1.1 × budget', () => {
    const sprintCandidates = candidates({ kana: times(10, kana), kanji: [] });
    expect(count(govern(input({ courseDay: 9, sprintComplete: false, candidates: sprintCandidates })), 'grammar')).toBe(1);
    expect(count(govern(input({ courseDay: 9, sprintComplete: false, candidates: sprintCandidates, due: due(80, 'comprehend') })), 'grammar')).toBe(0);
  });

  it('(i) offers one more kanji only with high accuracy, an under-budget week and room', () => {
    const offer = govern(input({ accuracy7: 0.96, underBudget7: true }));
    expect(count(offer, 'kanji')).toBe(3);
    expect(offer.offerExtraKanji).toBe(true);
    expect(govern(input({ accuracy7: 0.94, underBudget7: true })).offerExtraKanji).toBe(false);
    expect(govern(input({ accuracy7: 0.96, underBudget7: false })).offerExtraKanji).toBe(false);

    // A day already over 1.1·B − 188 (an evening after a full morning): no offer.
    const full = govern(input({
      accuracy7: 0.96,
      underBudget7: true,
      today: emptyToday({ kanji: 3, grammar: 1, reviewSec: 700, newSec: { ...zeroSec(), kanji: 564, grammar: 200 } }),
    }));
    expect(full.seconds.dayTotal + 188).toBeGreaterThan(cap(25));
    expect(full.offerExtraKanji).toBe(false);

    // Accepted: the ceiling is 4, but the 4th kanji still has to fit the room.
    const extra = govern(input({ extraKanji: true }));
    expect(count(extra, 'kanji')).toBe(4);
    expect(extra.offerExtraKanji).toBe(false);
    const tight = govern(input({ extraKanji: true, due: due(45, 'comprehend'), candidates: candidates({ core: [], grammar: null }) }));
    expect(tight.seconds.newRoom).toBe(750);
    expect(count(tight, 'kanji')).toBe(3);
    expect(tight.seconds.dayTotal).toBeLessThanOrEqual(cap(25));
  });

  it('(j) no first-sitting plan outside the sprint goes over 1.1 × budget', () => {
    const random = seededRandom(42);
    const keys: TimingKey[] = ['kanaRead', 'kanaWrite', 'kanjiWrite', 'kanjiMeaning', 'wordRead', 'produce', 'listen', 'comprehend', 'build', 'cloze'];
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
    for (let n = 0; n < 300; n++) {
      const budgetMin = pick([20, 25, 30, 40] as const);
      const dueCards = Array.from({ length: Math.floor(random() * 220) }, (_, i) => ({
        id: `r${n}-${i}`, key: pick(keys), r: 0.3 + random() * 0.7, value: pick([0, 1, 2] as const),
      }));
      const out = govern(input({
        budgetMin,
        courseDay: 15 + Math.floor(random() * 400),
        wordsKnown: Math.floor(random() * 3000),
        due: dueCards,
        upcoming: Array.from({ length: Math.floor(random() * 600) }, () => pick(keys)),
        candidates: candidates({
          kanji: times(Math.floor(random() * 5), () => kanji(random() > 0.1)),
          core: times(Math.floor(random() * 4), core),
          grammar: random() > 0.5 ? grammar() : null,
          grammarBelowFloor: random() > 0.5,
          staged: times(Math.floor(random() * 5), staged),
        }),
        spent14: { kanji: random() * 3000, core: random() * 1000, grammar: random() * 1000 },
        accuracy3: random() > 0.3 ? 0.6 + random() * 0.4 : null,
        accuracy7: random() > 0.3 ? 0.6 + random() * 0.4 : null,
        underBudget7: random() > 0.5,
        catchUpBefore: random() > 0.8,
        extraKanji: random() > 0.5,
      }));
      expect(out.mode).not.toBe('sprint');
      expect(out.seconds.dayTotal, `input ${n}`).toBeLessThanOrEqual(cap(budgetMin) + 1e-9);
    }
  });

  it('(k) a split day has the budget of one sitting', () => {
    const upcoming = Array.from({ length: 313 }, () => 'comprehend' as const); // F7 ≈ 500 s
    const morning = govern(input({ due: due(120, 'comprehend'), upcoming }));
    expect(morning.seconds.forecast7).toBeGreaterThan(500);
    expect(morning.seconds.newRoom).toBe(0);

    const evening = govern(input({ upcoming, today: emptyToday({ reviewSec: 1200 }) }));
    expect(evening.seconds.newRoom).toBe(0);
    expect(evening.seconds.dayTotal).toBeLessThanOrEqual(cap(25));
    const forgetful = govern(input({ upcoming }));
    expect(forgetful.seconds.newRoom).toBeCloseTo(700, -1);

    const fresh = govern(input({ upcoming }));
    const afterKanji = govern(input({ upcoming, today: emptyToday({ kanji: 3, newSec: { ...zeroSec(), kanji: 564 } }) }));
    expect(fresh.seconds.newRoom - afterKanji.seconds.newRoom).toBeCloseTo(564);
    expect(count(afterKanji, 'kanji')).toBe(0);
  });

  it('(l) once a sitting ran in catch-up the day stays in catch-up, within what is left', () => {
    const out = govern(input({ due: due(10, 'comprehend'), today: emptyToday({ catchUp: true, reviewSec: 1300 }) }));
    expect(out.mode).toBe('catch-up');
    expect(out.newItems).toEqual([]);
    // (25 − 3) · 60 − 1300 = 20 s left: two 10-s cards.
    expect(out.reviews).toHaveLength(2);
  });

  it('travel: reviews only, optional, no strand', () => {
    const out = govern(input({ travel: true, due: due(5, 'listen') }));
    expect(out).toMatchObject({ mode: 'travel', strandMin: 0, newItems: [] });
    expect(out.reviews).toHaveLength(5);
  });

  it('caps the reviews shown at 400', () => {
    const out = govern(input({ budgetMin: 40, courseDay: 61, due: due(450, 'kanaRead') }));
    expect(out.reviews.length).toBeLessThanOrEqual(400);
  });
});
