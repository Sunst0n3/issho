import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db.ts';
import { emptyDay } from './days.ts';
import { introduceItem } from './items.ts';
import {
  chapterInfo,
  chapterItems,
  coverageShare,
  HOUR_BENCHMARKS,
  markMilestoneSeen,
  PLAN_MILESTONES,
  recordMilestone,
  seasonFinaleDue,
  unseenMilestones,
} from './milestones.ts';
import { at, fixtures, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

describe('coverageShare', () => {
  it('interpolates the coverage table', () => {
    expect(coverageShare(300)).toBe(0.83);
    expect(coverageShare(250)).toBe(0.81);
    expect(coverageShare(100)).toBe(0.74);
    expect(coverageShare(99)).toBeNull();
    expect(coverageShare(1000)).toBe(0.95);
    expect(coverageShare(1500)).toBe(0.95);
  });
});

describe('chapterInfo', () => {
  it('shows the kana chapter, then chapters of 15 kanji', () => {
    expect(chapterInfo(0, 46, 92)).toMatchObject({ chapter: 0, done: 46, size: 92, text: 'Chapter 0 · Kana · 46 of 92' });
    expect(chapterInfo(15, 92, 92)).toMatchObject({ chapter: 2, done: 0, half: 'done' });
    expect(chapterInfo(6 * 15 + 5, 92, 92)).toMatchObject({ chapter: 7, done: 5, text: 'Chapter 7 · 5 of 15 done' });
    expect(chapterInfo(6 * 15 + 7, 92, 92)).toMatchObject({ half: 'done', text: 'Chapter 7 · 7 of 15 done' });
    expect(chapterInfo(6 * 15 + 9, 92, 92)).toMatchObject({ half: 'left', text: 'Chapter 7 · 6 to go' });
  });
});

describe('chapterItems', () => {
  it('lists what was introduced between a chapter’s first kanji and the next chapter’s', async () => {
    // Chapters of the fixture: units 0–1 in chapter 1, units 2–3 in chapter 2, units 4+ in chapter 3.
    fixtures.curriculum = {
      ...fixtures.curriculum,
      units: fixtures.curriculum.units.map((u) => ({ ...u, chapter: u.index < 2 ? 1 : u.index < 4 ? 2 : 3 })),
    };
    await db.days.put({ ...emptyDay('2026-03-01'), reviews: 1 });
    await introduceItem('kana', 'あ', at(2026, 3, 1));
    await introduceItem('core', 'cw-0001', at(2026, 3, 2));
    await introduceItem('kanji', '一', at(2026, 3, 5));
    await introduceItem('kanji', '二', at(2026, 3, 6));
    await introduceItem('kanji', '三', at(2026, 3, 10));
    await introduceItem('word', '2004', at(2026, 3, 10));
    await introduceItem('grammar', 'wa-desu', at(2026, 3, 12));
    await introduceItem('kanji', '四', at(2026, 3, 13));
    await introduceItem('kanji', '五', at(2026, 3, 20));
    await introduceItem('core', 'cw-0002', at(2026, 3, 21));

    const now = at(2026, 3, 22);
    expect(await chapterItems(0, now)).toEqual({ from: '2026-03-01', to: '2026-03-04', kanji: [], words: ['core:cw-0001'], grammar: [] });
    expect(await chapterItems(2, now)).toEqual({ from: '2026-03-10', to: '2026-03-19', kanji: ['三', '四'], words: ['word:2004'], grammar: ['wa-desu'] });
    expect(await chapterItems(3, now)).toEqual({ from: '2026-03-20', to: null, kanji: ['五'], words: ['core:cw-0002'], grammar: [] });
    expect((await chapterItems(5, now)).from).toBe('');
  });
});

describe('seasons, benchmarks and plan milestones', () => {
  it('is due at week 12 and not again once seen', () => {
    expect(seasonFinaleDue('2026-01-05', '2026-03-29', new Set())).toBeNull();
    expect(seasonFinaleDue('2026-01-05', '2026-03-30', new Set())).toBe(1);
    expect(seasonFinaleDue('2026-01-05', '2026-03-30', new Set(['season:1']))).toBeNull();
    expect(seasonFinaleDue('2026-01-05', '2026-06-22', new Set(['season:1']))).toBe(2);
  });

  it('lists the benchmarks and the plan milestones', () => {
    expect(HOUR_BENCHMARKS.map((b) => [b.id, b.from, b.to])).toEqual([['n5', 250, 400], ['n4', 500, 750], ['fsi', 2200, 2200]]);
    expect(PLAN_MILESTONES.find((m) => m.id === 'M3')).toEqual({ id: 'M3', day: 365, kanji: [265, 310], words: 1550, grammar: [85, 100] });
  });
});

describe('milestone records', () => {
  it('records once and remembers what was shown', async () => {
    await recordMilestone('kana-check', at(2026, 3, 1));
    await recordMilestone('kana-check', at(2026, 3, 2));
    expect(await db.milestones.toArray()).toEqual([{ id: 'kana-check', reachedAt: at(2026, 3, 1) }]);
    await recordMilestone('M0', at(2026, 3, 3));
    expect((await unseenMilestones()).map((m) => m.id)).toEqual(['kana-check', 'M0']);
    await markMilestoneSeen('kana-check', at(2026, 3, 4));
    await markMilestoneSeen('kana-check', at(2026, 3, 5));
    expect((await db.milestones.get('kana-check'))?.seenAt).toEqual(at(2026, 3, 4));
    expect((await unseenMilestones()).map((m) => m.id)).toEqual(['M0']);
  });
});
