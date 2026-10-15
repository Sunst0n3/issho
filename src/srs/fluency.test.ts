import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db.ts';
import type { AccentInfo, CardRecord, CardType, ItemKind } from '../lib/types.ts';
import { DAY_MS } from './days.ts';
import { fluencyKindFor, logFluency, nextRotation, numbersDrillScope, pickFluency, speedRoundCards } from './fluency.ts';
import { introduceItem } from './items.ts';
import { gradeCard, newCardRecord } from './scheduler.ts';
import { at, fixtures, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const MONDAY = at(2026, 3, 16, 9);
const TUESDAY = at(2026, 3, 17, 9);
const SUNDAY = at(2026, 3, 22, 9);

function stableCard(itemId: string, type: CardType, stability: number, patch: Partial<CardRecord> = {}): CardRecord {
  const kind = itemId.slice(0, itemId.indexOf(':')) as ItemKind;
  return { ...newCardRecord(itemId, kind, type, at(2026, 1, 1)), state: State.Review, stability, difficulty: 5, reps: 5, last_review: at(2026, 3, 1), due: at(2026, 4, 30), ...patch };
}

describe('fluency kinds', () => {
  it('runs the pitch drill on Mon/Wed/Fri, the rotation on Tue/Thu/Sat, nothing on Sunday', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(fluencyKindFor)).toEqual(['pitch', 'rotation', 'pitch', 'rotation', 'pitch', 'rotation', null]);
  });

  it('rotates re-read → speed → numbers, skipping ineligible kinds', () => {
    const all = { reread: true, speed: true, numbers: true };
    expect(nextRotation(undefined, all)).toBe('reread');
    expect(nextRotation('reread', all)).toBe('speed');
    expect(nextRotation('numbers', all)).toBe('reread');
    expect(nextRotation('reread', { reread: true, speed: false, numbers: true })).toBe('numbers');
    expect(nextRotation('speed', { reread: false, speed: true, numbers: false })).toBe('speed');
    expect(nextRotation('speed', { reread: false, speed: false, numbers: false })).toBeNull();
  });
});

describe('speedRoundCards', () => {
  it('uses only stable receptive cards, at most 40, the same cards all day', async () => {
    const cards = [
      ...Array.from({ length: 45 }, (_, i) => stableCard(`word:${i}`, 'read', 30)),
      stableCard('core:cw-0001', 'listen', 25),
      stableCard('kanji:乙', 'meaning', 22),
      stableCard('word:soft', 'read', 20),
      stableCard('kanji:日', 'write', 40),
      stableCard('word:p', 'produce', 40),
      stableCard('word:r', 'read', 40, { suspended: 'retired' }),
    ];
    await db.cards.bulkPut(cards);
    const picked = await speedRoundCards(TUESDAY);
    expect(picked).toHaveLength(40);
    expect(picked.every((id) => /\|(read|listen|meaning)$/.test(id))).toBe(true);
    expect(picked).not.toContain('word:soft|read');
    expect(picked).not.toContain('word:r|read');
    expect(await speedRoundCards(at(2026, 3, 17, 20))).toEqual(picked);
    expect(await speedRoundCards(TUESDAY, 5)).toHaveLength(5);
  });
});

describe('numbers drill scope', () => {
  it('drills only the counters, time and prices whose grammar is introduced', async () => {
    expect(await numbersDrillScope()).toEqual({ counters: [], time: false, prices: false });
    await introduceItem('grammar', 'numbers-prices', MONDAY);
    await introduceItem('grammar', 'counting-tsu', MONDAY);
    expect(await numbersDrillScope()).toEqual({ counters: ['つ'], time: false, prices: true });
    await introduceItem('grammar', 'counters-objects', MONDAY);
    await introduceItem('grammar', 'time-telling', MONDAY);
    expect(await numbersDrillScope()).toEqual({ counters: ['つ', '枚', '本', '杯', '匹', '個', '回'], time: true, prices: true });
  });
});

describe('pickFluency', () => {
  async function knownPitchWords(n: number) {
    const accent: Record<string, AccentInfo> = {};
    const byRef: Record<string, string> = {};
    for (let i = 1; i <= n; i++) {
      const id = `cw-${String(i).padStart(4, '0')}`;
      await introduceItem('core', id, at(2026, 2, 1));
      await gradeCard(`core:${id}|listen`, Rating.Good, { durationMs: 1, mode: 'self', now: at(2026, 2, 2) });
      accent[`core:${id}`] = { moras: ['ア', 'イ'], drop: i % 3, type: i % 3 === 0 ? 'heiban' : 'atamadaka', withGa: true };
      byRef[`pitch:core:${id}`] = `clip${i}`;
    }
    fixtures.accent = accent;
    fixtures.manifest = { ...fixtures.manifest, byRef };
  }

  it('is null before the strand reaches 6 minutes, on Sundays, and in catch-up, micro, travel and make-up plans', async () => {
    await knownPitchWords(8);
    expect(await pickFluency({ strandMin: 4, mode: 'normal' }, MONDAY)).toBeNull();
    expect(await pickFluency({ strandMin: 8, mode: 'normal' }, SUNDAY)).toBeNull();
    for (const mode of ['catch-up', 'micro', 'travel', 'makeup', 'welcome-back'] as const) {
      expect(await pickFluency({ strandMin: 8, mode }, MONDAY)).toBeNull();
    }
    expect((await pickFluency({ strandMin: 6, mode: 'normal' }, MONDAY))?.kind).toBe('pitch');
  });

  it('runs the pitch drill on a pitch day with 8 drillable words', async () => {
    await knownPitchWords(8);
    const plan = await pickFluency({ strandMin: 8, mode: 'normal' }, MONDAY);
    expect(plan?.kind).toBe('pitch');
    expect(plan?.pitch?.length).toBeGreaterThanOrEqual(8);
    expect(plan?.pitch?.every((p) => p.clipRef.startsWith('pitch:'))).toBe(true);
  });

  it('uses another eligible kind when today’s is not', async () => {
    await knownPitchWords(7);
    expect(await pickFluency({ strandMin: 8, mode: 'normal' }, MONDAY)).toBeNull();
    await introduceItem('grammar', 'numbers-prices', at(2026, 2, 1));
    await introduceItem('grammar', 'counting-tsu', at(2026, 2, 1));
    const numbers = await pickFluency({ strandMin: 8, mode: 'normal' }, MONDAY);
    expect(numbers?.kind).toBe('numbers');
    expect(numbers?.numbers?.filter((i) => i.kind === 'counter').every((i) => i.prompt.endsWith('つ'))).toBe(true);
    expect(numbers?.numbers?.some((i) => i.kind === 'time')).toBe(false);
  });

  it('rotates on rotation days from the last fluency kind', async () => {
    await introduceItem('grammar', 'numbers-prices', at(2026, 2, 1));
    await db.cards.bulkPut(Array.from({ length: 25 }, (_, i) => stableCard(`word:${i}`, 'read', 30)));
    await db.stories.put({ storyId: 'st', stage: 1, firstDay: '2026-03-08', nextDay: '2026-03-11', gist: [], cpm: [] });
    expect(await pickFluency({ strandMin: 8, mode: 'normal' }, TUESDAY)).toEqual({ kind: 'reread', storyId: 'st' });
    await logFluency('reread', 220, 'st', at(2026, 3, 14));
    expect((await pickFluency({ strandMin: 8, mode: 'normal' }, TUESDAY))?.kind).toBe('speed');
    await logFluency('speed', 30, undefined, at(2026, 3, 15));
    expect((await pickFluency({ strandMin: 8, mode: 'normal' }, TUESDAY))?.kind).toBe('numbers');
    expect((await db.fluency.toArray()).map((f) => [f.kind, f.day])).toEqual([['reread', '2026-03-14'], ['speed', '2026-03-15']]);
    expect(DAY_MS).toBe(86_400_000);
  });
});
