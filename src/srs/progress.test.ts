import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../lib/db.ts';
import type { CardRecord, CardType, ItemKind, ReviewContext, ReviewLogRecord } from '../lib/types.ts';
import { DAY_MS, emptyDay, getDay } from './days.ts';
import { introduceItem } from './items.ts';
import {
  addStudyTime,
  charsPerMinute,
  familyOf,
  hardestKanji,
  hoursTotal,
  isLearned,
  knownKanji,
  learnedCounts,
  learnedToday,
  rankHardKanji,
  readingSpeed,
  retentionFrom,
  weekStats,
} from './progress.ts';
import { newCardRecord } from './scheduler.ts';
import { at, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const day = (d: number, h = 9) => at(2026, 3, d, h);
const pass = (d: number) => ({ grade: Rating.Good as const, reviewedAt: day(d) });

describe('isLearned', () => {
  it('needs 3 successes on 3 distinct days after the introduction day', () => {
    expect(isLearned([pass(1), pass(1), pass(3)], '2026-02-28')).toBe(false);
    expect(isLearned([pass(1), pass(3), pass(9)], '2026-02-28')).toBe(true);
    expect(isLearned([pass(1), pass(3), pass(9)], '2026-03-01')).toBe(false);
    expect(isLearned([pass(2), pass(3), { grade: Rating.Again as const, reviewedAt: day(9) }], '2026-03-01')).toBe(false);
  });
});

function log(kind: ItemKind, type: CardType, elapsedDays: number, grade: number, patch: Partial<ReviewLogRecord> = {}): ReviewLogRecord {
  return {
    cardId: `${kind}:x|${type}`, itemId: `${kind}:x`, kind, type, grade: grade as ReviewLogRecord['grade'], reviewedAt: day(15),
    durationMs: 5000, mode: 'typed', prevState: State.Review, elapsedDays, context: 'review' as ReviewContext, ...patch,
  };
}

describe('retentionFrom', () => {
  const now = day(20);

  it('buckets review logs by elapsed days and family', () => {
    const logs = [
      ...Array.from({ length: 10 }, (_, i) => log('kanji', 'write', 7, i < 9 ? 3 : 1)),
      ...Array.from({ length: 12 }, (_, i) => log('word', 'read', 30, i < 6 ? 3 : 1)),
      ...Array.from({ length: 5 }, () => log('core', 'listen', 7, 3)),
      log('kanji', 'write', 7, 1, { context: 'first-check' }),
      log('kanji', 'write', 7, 1, { prevState: State.Learning }),
      log('kanji', 'write', 7, 1, { reviewedAt: at(2026, 1, 1) }),
      log('kanji', 'write', 15, 1),
      log('grammar', 'comprehend', 7, 3, { context: 'partner' }),
    ];
    const stats = retentionFrom(logs, now);
    const of = (family: string) => stats.find((s) => s.family === family)!;
    expect(of('write').week).toEqual({ n: 10, rate: 0.9 });
    expect(of('write').month).toEqual({ n: 0, rate: null });
    expect(of('read').month).toEqual({ n: 12, rate: 0.5 });
    expect(of('listen').week).toEqual({ n: 5, rate: null });
    expect(of('grammar').week).toEqual({ n: 1, rate: null });
    expect(stats.map((s) => s.family)).toEqual(['write', 'read', 'listen', 'produce', 'grammar']);
  });

  it('maps card types to families', () => {
    expect(familyOf('kana', 'write')).toBe('write');
    expect(familyOf('kanaRule', 'read')).toBe('read');
    expect(familyOf('kanji', 'meaning')).toBe('read');
    expect(familyOf('core', 'listen')).toBe('listen');
    expect(familyOf('sentence', 'cloze')).toBe('produce');
    expect(familyOf('word', 'produce')).toBe('produce');
    expect(familyOf('grammar', 'build')).toBe('grammar');
  });
});

describe('time and speed', () => {
  it('computes characters per minute', () => {
    expect(charsPerMinute(300, 60_000)).toBe(300);
    expect(charsPerMinute(300, 90_000)).toBe(200);
    expect(charsPerMinute(300, 0)).toBe(0);
  });

  it('adds lesson, strand and make-up time', async () => {
    const now = day(20);
    await addStudyTime(60_000, 'lesson', now);
    await addStudyTime(30_000, 'strand', now);
    await addStudyTime(20_000, 'makeup', now);
    await addStudyTime(Number.NaN, 'strand', now);
    expect(await getDay('2026-03-20')).toMatchObject({ studyMs: 110_000, strandMs: 30_000, makeupMs: 20_000, reviewMs: 0 });
  });

  it('totals solo and together hours', async () => {
    await db.days.bulkPut([
      { ...emptyDay('2026-03-01'), studyMs: 3_600_000, togetherMs: 1_800_000 },
      { ...emptyDay('2026-03-02'), studyMs: 1_800_000 },
    ]);
    expect(await hoursTotal()).toBe(2);
  });

  it('reports the latest and best re-read speed', async () => {
    expect(await readingSpeed()).toEqual({ latest: null, best: null });
    await db.fluency.bulkAdd([
      { kind: 'reread', day: '2026-03-01', at: day(1), value: 200 },
      { kind: 'reread', day: '2026-03-08', at: day(8), value: 260 },
      { kind: 'reread', day: '2026-03-15', at: day(15), value: 240 },
      { kind: 'speed', day: '2026-03-15', at: day(15), value: 30 },
    ]);
    expect(await readingSpeed()).toEqual({ latest: 240, best: 260 });
  });

  it('lists the last 14 days, oldest first', async () => {
    await db.days.put({ ...emptyDay('2026-03-20'), reviews: 4 });
    const days = await weekStats(day(20));
    expect(days).toHaveLength(14);
    expect(days[0].date).toBe('2026-03-07');
    expect(days[13]).toMatchObject({ date: '2026-03-20', reviews: 4 });
  });
});

describe('learned counts', () => {
  async function addLogs(cardId: string, days: number[], grade: Rating.Good | Rating.Again = Rating.Good) {
    const [itemId, type] = cardId.split('|');
    const kind = itemId.slice(0, itemId.indexOf(':')) as ItemKind;
    await db.reviewLogs.bulkAdd(days.map((d) => log(kind, type as CardType, 1, grade, { cardId, itemId, reviewedAt: day(d) })));
  }

  it('counts what is learned, never the first check', async () => {
    await introduceItem('kanji', '日', day(1));
    await introduceItem('kanji', '人', day(1));
    await introduceItem('word', '1002', day(1), { ctx: { use: true } });
    await introduceItem('core', 'cw-0001', day(1));
    await introduceItem('grammar', 'wa-desu', day(1));
    await introduceItem('kana', 'あ', day(1), { via: 'placement' });
    await addLogs('kanji:日|write', [1, 2, 4, 8]);
    await addLogs('kanji:人|write', [1, 2, 4]);
    await addLogs('word:1002|read', [2, 4, 8]);
    await addLogs('core:cw-0001|listen', [2, 4, 8]);
    await addLogs('grammar:wa-desu|comprehend', [2, 4]);
    expect(await learnedCounts(day(20))).toEqual({
      kanaLearned: 1,
      kanjiCanWrite: 1,
      kanjiCanRead: 1, // 日 through 日本; 本 is not introduced
      wordsLearned: 2,
      grammarLearned: 0,
      kanjiIntroduced: 2,
      wordsIntroduced: 2,
      grammarIntroduced: 1,
    });
  });

  it('lists known kanji oldest first and today’s items without placement', async () => {
    await introduceItem('kanji', '人', day(2));
    await introduceItem('kanji', '日', day(1));
    await introduceItem('word', '1002', day(20, 10));
    await introduceItem('kana', 'あ', day(20, 9), { via: 'placement' });
    await introduceItem('core', 'cw-0001', day(20, 11));
    expect(await knownKanji()).toEqual(['日', '人']);
    expect(await learnedToday(day(20, 12))).toEqual(['word:1002', 'core:cw-0001']);
  });
});

describe('hardest kanji', () => {
  const card = (char: string, type: CardType, lapses: number, stability: number, patch: Partial<CardRecord> = {}): CardRecord => ({
    ...newCardRecord(`kanji:${char}`, 'kanji', type, day(1)), state: State.Review, reps: 4, lapses, stability, ...patch,
  });

  it('ranks write cards by lapses, then stability', async () => {
    const cards = [
      card('日', 'write', 2, 5),
      card('人', 'write', 3, 9),
      card('本', 'write', 2, 2),
      card('乙', 'meaning', 9, 1),
      card('元', 'write', 9, 1, { suspended: 'retired' }),
      card('気', 'write', 0, 1, { reps: 0 }),
    ];
    expect(rankHardKanji(cards, 3).map((k) => k.char)).toEqual(['人', '本', '日']);
    await db.cards.bulkPut(cards);
    expect((await hardestKanji(1))[0]).toEqual({ char: '人', lapses: 3, stability: 9 });
    expect(DAY_MS).toBe(86_400_000);
  });
});
