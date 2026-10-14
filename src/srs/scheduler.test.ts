import { Rating, State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../lib/db.ts';
import type { CardRecord } from '../lib/types.ts';
import { DAY_MS } from './days.ts';
import { gradeCard, MAX_COUNTED_ANSWER_MS, newCardRecord, previewDue } from './scheduler.ts';
import { at, resetDb } from './test-fixtures.ts';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const NOW = at(2026, 10, 14, 9);

function reviewCard(id = 'kanji:水', stability = 10): CardRecord {
  return {
    ...newCardRecord(id, 'kanji', 'meaning', new Date(NOW.getTime() - stability * DAY_MS)),
    state: State.Review,
    stability,
    difficulty: 5,
    reps: 3,
    scheduled_days: stability,
    last_review: new Date(NOW.getTime() - stability * DAY_MS),
    due: NOW,
  };
}

describe('newCardRecord', () => {
  it('creates a new FSRS card due now with the composite id', () => {
    const card = newCardRecord('kana:あ', 'kana', 'write', NOW);
    expect(card).toMatchObject({ id: 'kana:あ|write', itemId: 'kana:あ', kind: 'kana', type: 'write', state: State.New, reps: 0 });
    expect(card.due).toBeInstanceOf(Date);
    expect(card.due.getTime()).toBe(NOW.getTime());
  });
});

describe('gradeCard', () => {
  it('reschedules the card, logs the review and counts it for today', async () => {
    await db.cards.add(newCardRecord('kana:あ', 'kana', 'read', NOW));
    const updated = await gradeCard('kana:あ|read', Rating.Good, { durationMs: 4200, mode: 'choice', now: NOW });

    expect(updated.state).toBe(State.Learning);
    expect(updated.due.getTime()).toBeGreaterThan(NOW.getTime());
    expect(updated).toMatchObject({ id: 'kana:あ|read', itemId: 'kana:あ', kind: 'kana', type: 'read', reps: 1 });

    const stored = await db.cards.get('kana:あ|read');
    expect(stored).toEqual(updated);
    expect(stored!.due).toBeInstanceOf(Date);
    expect(stored!.last_review).toBeInstanceOf(Date);

    const logs = await db.reviewLogs.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      cardId: 'kana:あ|read',
      itemId: 'kana:あ',
      grade: Rating.Good,
      durationMs: 4200,
      mode: 'choice',
      prevState: State.New,
    });
    expect(logs[0].reviewedAt).toBeInstanceOf(Date);

    expect(await db.days.get('2026-10-14')).toMatchObject({ reviews: 1, correct: 1, studyMs: 4200, newItems: 0 });
  });

  it('counts Again as reviewed but not correct, and Hard as correct', async () => {
    await db.cards.bulkAdd([newCardRecord('kana:い', 'kana', 'read', NOW), newCardRecord('kana:う', 'kana', 'read', NOW)]);
    await gradeCard('kana:い|read', Rating.Again, { durationMs: 1000, mode: 'typed', now: NOW });
    await gradeCard('kana:う|read', Rating.Hard, { durationMs: 1000, mode: 'typed', now: NOW });
    expect(await db.days.get('2026-10-14')).toMatchObject({ reviews: 2, correct: 1, studyMs: 2000 });
  });

  it('caps the study time one answer can add, but logs the real duration', async () => {
    await db.cards.add(newCardRecord('kana:あ', 'kana', 'read', NOW));
    await gradeCard('kana:あ|read', Rating.Good, { durationMs: 30 * 60_000, mode: 'self', now: NOW });
    expect((await db.days.get('2026-10-14'))!.studyMs).toBe(MAX_COUNTED_ANSWER_MS);
    expect((await db.reviewLogs.toArray())[0].durationMs).toBe(30 * 60_000);
  });

  it('treats a missing or broken answer time as zero instead of corrupting the day', async () => {
    await db.cards.bulkAdd([newCardRecord('kana:あ', 'kana', 'read', NOW), newCardRecord('kana:い', 'kana', 'read', NOW)]);
    await gradeCard('kana:あ|read', Rating.Good, { durationMs: Number.NaN, mode: 'choice', now: NOW });
    await gradeCard('kana:い|read', Rating.Good, { durationMs: 1500, mode: 'choice', now: NOW });
    expect(await db.days.get('2026-10-14')).toMatchObject({ reviews: 2, studyMs: 1500 });
    expect((await db.reviewLogs.toArray()).map((l) => l.durationMs)).toEqual([0, 1500]);
  });

  it('books reviews done before 4 a.m. on the previous study day', async () => {
    const lateNight = at(2026, 10, 15, 2, 30);
    await db.cards.add(newCardRecord('kana:あ', 'kana', 'read', lateNight));
    await gradeCard('kana:あ|read', Rating.Good, { durationMs: 1000, mode: 'choice', now: lateNight });
    expect(await db.days.get('2026-10-14')).toMatchObject({ reviews: 1 });
    expect(await db.days.get('2026-10-15')).toBeUndefined();
  });

  it('still grades a card when the clock is behind its last review', async () => {
    const card = reviewCard('kanji:木', 10);
    await db.cards.add({ ...card, last_review: at(2026, 10, 20, 9), due: at(2026, 10, 30, 9) });
    const earlier = at(2026, 10, 14, 9);
    const next = await gradeCard(card.id, Rating.Good, { durationMs: 1, mode: 'choice', now: earlier });
    expect(next.due.getTime()).toBeGreaterThan(at(2026, 10, 20, 9).getTime());
    expect((await db.reviewLogs.toArray())[0].reviewedAt).toEqual(earlier);
    expect(await db.days.get('2026-10-14')).toMatchObject({ reviews: 1 });
  });

  it('rejects an unknown card without writing anything', async () => {
    await expect(gradeCard('kana:ぬ|read', Rating.Good, { durationMs: 1, mode: 'choice', now: NOW })).rejects.toThrow(/unknown card/);
    expect(await db.reviewLogs.count()).toBe(0);
    expect(await db.days.count()).toBe(0);
  });

  it('rolls back the card update when a later write fails', async () => {
    const card = newCardRecord('kana:あ', 'kana', 'read', NOW);
    await db.cards.add(card);
    vi.spyOn(db.reviewLogs, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(gradeCard(card.id, Rating.Good, { durationMs: 1, mode: 'choice', now: NOW })).rejects.toThrow('disk full');
    expect((await db.cards.get(card.id))!.state).toBe(State.New);
    expect(await db.days.count()).toBe(0);
  });

  it('uses the desired retention from settings', async () => {
    const intervalAt = async (retention: number, id: string) => {
      await updateSettings({ desiredRetention: retention });
      await db.cards.add(reviewCard(id, 20));
      const next = await gradeCard(`${id}|meaning`, Rating.Good, { durationMs: 1, mode: 'choice', now: NOW });
      return (next.due.getTime() - NOW.getTime()) / DAY_MS;
    };
    const relaxed = await intervalAt(0.8, 'kanji:山');
    const strict = await intervalAt(0.97, 'kanji:川');
    expect(relaxed).toBeGreaterThan(strict * 2);
  });
});

describe('previewDue', () => {
  it('gives a due date per grade, Again soonest and Easy latest', () => {
    const preview = previewDue(reviewCard(), NOW);
    expect(Object.keys(preview)).toEqual(['1', '2', '3', '4']);
    const times = [preview[1], preview[2], preview[3], preview[4]].map((d) => d.getTime());
    expect(times.every((t) => t > NOW.getTime())).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBeLessThan(times[3]);
  });

  it('works when the clock is behind the last review', () => {
    const card = { ...reviewCard(), last_review: at(2026, 10, 20, 9) };
    const preview = previewDue(card, at(2026, 10, 14, 9));
    expect(preview[3].getTime()).toBeGreaterThan(at(2026, 10, 20, 9).getTime());
  });

  it('shows learning steps for a new card', () => {
    const preview = previewDue(newCardRecord('kana:あ', 'kana', 'read', NOW), NOW);
    expect(preview[1].getTime() - NOW.getTime()).toBeLessThan(10 * 60_000);
    expect(preview[4].getTime() - NOW.getTime()).toBeGreaterThanOrEqual(DAY_MS);
  });
});
