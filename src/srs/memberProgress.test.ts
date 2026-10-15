import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db.ts';
import type { ItemRecord } from '../lib/types.ts';
import { DAY_MS, emptyDay } from './days.ts';
import { introduceItem } from './items.ts';
import { memberProgress, reachedOrder, recentItemIds, settledUnitFrom } from './memberProgress.ts';
import { at, GRAMMAR, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const NOW = at(2026, 3, 20, 9);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describe('settledUnitFrom', () => {
  // Fixture units: 1 = orders 1–4, 2 = 5–8, 3 = 9–12.
  const unit1 = GRAMMAR.filter((g) => g.unit === 1).map((g) => g.id);
  const unit2 = GRAMMAR.filter((g) => g.unit === 2).map((g) => g.id);

  it('counts a unit only when all its grammar was introduced at least 2 days ago', () => {
    const intro = (ids: string[], day: string) => ids.map((id): [string, string] => [`grammar:${id}`, day]);
    expect(settledUnitFrom(GRAMMAR, new Map(), '2026-03-20')).toBe(0);
    expect(settledUnitFrom(GRAMMAR, new Map(intro(unit1, '2026-03-18')), '2026-03-20')).toBe(1);
    expect(settledUnitFrom(GRAMMAR, new Map(intro(unit1, '2026-03-19')), '2026-03-20')).toBe(0);
    const partial = new Map([...intro(unit1, '2026-03-01'), ...intro(unit2.slice(0, 3), '2026-03-01')]);
    expect(settledUnitFrom(GRAMMAR, partial, '2026-03-20')).toBe(1);
    const both = new Map([...intro(unit1, '2026-03-01'), ...intro(unit2, '2026-03-18')]);
    expect(settledUnitFrom(GRAMMAR, both, '2026-03-20')).toBe(2);
  });
});

describe('reachedOrder', () => {
  const entries = [1, 2, 3, 4, 474].map((order) => ({ id: `cw-${order}`, order }));

  it('counts how far the in-order stream reached, not the highest order met out of order', () => {
    expect(reachedOrder(entries, () => false)).toBe(0);
    expect(reachedOrder(entries, (id) => ['cw-1', 'cw-2'].includes(id))).toBe(2);
    // A core word introduced as day 15's kanji anchor (order 474) says nothing about orders 3–473.
    expect(reachedOrder(entries, (id) => ['cw-1', 'cw-2', 'cw-474'].includes(id))).toBe(2);
    expect(reachedOrder([...entries].reverse(), (id) => id !== 'cw-474')).toBe(4);
    expect(reachedOrder(entries, () => true)).toBe(474);
  });
});

describe('recentItemIds', () => {
  it('keeps items 2–21 days old, newest first, at most 20', () => {
    const items: ItemRecord[] = [
      ...Array.from({ length: 25 }, (_, i): ItemRecord => ({ id: `word:${i}`, kind: 'word', key: String(i), introducedAt: ago(2 + (i % 20)) })),
      { id: 'word:today', kind: 'word', key: 'today', introducedAt: NOW },
      { id: 'word:yesterday', kind: 'word', key: 'yesterday', introducedAt: ago(1) },
      { id: 'word:old', kind: 'word', key: 'old', introducedAt: ago(22) },
      { id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: ago(5) },
    ];
    const recent = recentItemIds(items, '2026-03-20', new Set(['word']));
    expect(recent).toHaveLength(20);
    expect(recent).not.toContain('word:today');
    expect(recent).not.toContain('word:yesterday');
    expect(recent).not.toContain('word:old');
    expect(recent[0]).toBe('word:0');
  });
});

describe('memberProgress', () => {
  it('summarises progress for the partner', async () => {
    await db.days.put({ ...emptyDay('2026-03-19'), studyMs: 3_600_000, minimumDone: true });
    for (const id of ['wa-desu', 'ka-question', 'no-possession', 'mo-also']) await introduceItem('grammar', id, ago(5));
    await introduceItem('grammar', 'ga-subject', ago(1));
    await introduceItem('core', 'cw-0001', ago(10));
    await introduceItem('core', 'cw-0012', ago(3));
    await introduceItem('kanji', '日', ago(4));
    await introduceItem('kanji', '人', NOW);
    await introduceItem('kana', 'あ', ago(15));
    const p = await memberProgress(NOW);
    expect(p).toMatchObject({
      unit: 2,
      chapter: 1,
      settledUnit: 1,
      // cw-0012 came out of order (as an anchor would), so the core stream has reached cw-0001 only.
      coreReached: 1,
      grammarReached: 5,
      hoursTotal: 1,
      daysThisMonth: 1,
      longestStreak: 1,
      recentKanji: ['日'],
      readyStories: [],
    });
    expect(p.recentItems).toEqual(['core:cw-0012', 'kanji:日', 'grammar:ka-question', 'grammar:mo-also', 'grammar:no-possession', 'grammar:wa-desu', 'core:cw-0001']);
  });
});
