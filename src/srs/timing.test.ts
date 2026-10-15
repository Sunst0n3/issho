import { State } from 'ts-fsrs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import type { ReviewLogRecord } from '../lib/types.ts';
import { at, resetDb } from './test-fixtures.ts';
import { DEFAULT_SECONDS, medianSeconds, secondsPerKey, timingKeyOf } from './timing.ts';

beforeEach(resetDb);

describe('timingKeyOf', () => {
  it('maps each card to its timing key', () => {
    expect(timingKeyOf('kana', 'read')).toBe('kanaRead');
    expect(timingKeyOf('kanaRule', 'read')).toBe('kanaRead');
    expect(timingKeyOf('kana', 'write')).toBe('kanaWrite');
    expect(timingKeyOf('kanji', 'write')).toBe('kanjiWrite');
    expect(timingKeyOf('kanji', 'meaning')).toBe('kanjiMeaning');
    expect(timingKeyOf('word', 'read')).toBe('wordRead');
    expect(timingKeyOf('core', 'read')).toBe('wordRead');
    expect(timingKeyOf('core', 'produce')).toBe('produce');
    expect(timingKeyOf('core', 'listen')).toBe('listen');
    expect(timingKeyOf('grammar', 'comprehend')).toBe('comprehend');
    expect(timingKeyOf('grammar', 'build')).toBe('build');
    expect(timingKeyOf('sentence', 'cloze')).toBe('cloze');
  });
});

describe('medianSeconds', () => {
  it('needs 30 durations and clamps the median to 3–60 s', () => {
    expect(medianSeconds(Array(29).fill(5000))).toBeNull();
    expect(medianSeconds([...Array(15).fill(4000), ...Array(15).fill(6000)])).toBe(5);
    expect(medianSeconds(Array(30).fill(500))).toBe(3);
    expect(medianSeconds(Array(30).fill(600_000))).toBe(60);
  });
});

describe('secondsPerKey', () => {
  it('uses the learner’s median once there are enough logs of a key', async () => {
    const log = (i: number, kind: 'kana' | 'word', ms: number): ReviewLogRecord => ({
      cardId: `${kind}:${i}|read`, itemId: `${kind}:${i}`, kind, type: 'read', grade: 3, reviewedAt: at(2026, 3, 1, 9, i % 60),
      durationMs: ms, mode: 'typed', prevState: State.Review, elapsedDays: 3, context: 'review',
    });
    await db.reviewLogs.bulkAdd([...Array.from({ length: 40 }, (_, i) => log(i, 'kana', 4000)), ...Array.from({ length: 10 }, (_, i) => log(i, 'word', 30_000))]);
    const seconds = await secondsPerKey(at(2026, 3, 2));
    expect(seconds.kanaRead).toBe(4);
    expect(seconds.wordRead).toBe(DEFAULT_SECONDS.wordRead);
    expect(seconds.kanjiWrite).toBe(22);
  });

  it('takes the last 200 timed logs of each key and leaves out partner verdicts (logged with 0 ms)', async () => {
    const t0 = at(2026, 3, 1, 9).getTime();
    const log = (i: number, kind: 'kanji' | 'kana', ms: number, mode: ReviewLogRecord['mode'] = 'written'): ReviewLogRecord => ({
      cardId: `${kind}:${i}|write`, itemId: `${kind}:${i}`, kind, type: 'write', grade: 3, reviewedAt: new Date(t0 + i * 60_000),
      durationMs: ms, mode, prevState: State.Review, elapsedDays: 3, context: mode === 'partner' ? 'partner' : 'review',
    });
    await db.reviewLogs.bulkAdd([
      // Older kanji writes at 40 s, then the latest 200 at 20 s: only the latest count.
      ...Array.from({ length: 150 }, (_, i) => log(i, 'kanji', 40_000)),
      ...Array.from({ length: 200 }, (_, i) => log(150 + i, 'kanji', 20_000)),
      // Partner verdicts in between carry no duration and must not drag the median down.
      ...Array.from({ length: 300 }, (_, i) => log(350 + i, 'kanji', 0, 'partner')),
      // Kana writes share the card type: an old run of 40 is still found behind the kanji logs.
      ...Array.from({ length: 40 }, (_, i) => log(-100 - i, 'kana', 9000)),
    ]);
    const seconds = await secondsPerKey(at(2026, 3, 3));
    expect(seconds.kanjiWrite).toBe(20);
    expect(seconds.kanaWrite).toBe(9);
  });
});
