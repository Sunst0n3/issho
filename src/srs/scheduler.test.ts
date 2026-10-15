import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, updateSettings } from '../lib/db.ts';
import type { CardRecord, CardType, ItemKind } from '../lib/types.ts';
import { DAY_MS, getDay } from './days.ts';
import {
  getScheduler,
  gradeCard,
  inPartnerWindow,
  MAX_COUNTED_ANSWER_MS,
  newCardRecord,
  PARTNER_GRADE,
  presetOf,
  previewDue,
  retentionFor,
  retrievability,
} from './scheduler.ts';
import { at, resetDb } from './test-fixtures.ts';

beforeEach(resetDb);

const NOW = at(2026, 10, 14, 9);
const MIN = 60_000;

function reviewCard(itemId: string, kind: ItemKind, type: CardType, stability = 10, dueIn = 0): CardRecord {
  const last = new Date(NOW.getTime() - stability * DAY_MS);
  return {
    ...newCardRecord(itemId, kind, type, last),
    state: State.Review,
    stability,
    difficulty: 5,
    reps: 3,
    scheduled_days: stability,
    last_review: last,
    due: new Date(NOW.getTime() + dueIn * DAY_MS),
  };
}

describe('presets', () => {
  it('maps card types to the production and receptive presets', () => {
    for (const type of ['write', 'produce', 'build', 'cloze'] as const) expect(presetOf(type)).toBe('production');
    for (const type of ['read', 'meaning', 'listen', 'comprehend'] as const) expect(presetOf(type)).toBe('receptive');
  });

  it('keeps production at 0.90 whatever the receptive setting', () => {
    expect(retentionFor('production', { receptiveRetention: 0.85 })).toBe(0.9);
    expect(retentionFor('receptive', { receptiveRetention: 0.85 })).toBe(0.85);
    expect(retentionFor('receptive', { receptiveRetention: 0.97 })).toBe(0.93);
  });

  it('refuses retentions outside 0.70–0.95', () => {
    expect(() => getScheduler(0.96)).toThrow(RangeError);
    expect(() => getScheduler(0.6)).toThrow(RangeError);
    expect(getScheduler(0.9)).toBe(getScheduler(0.9));
    expect(getScheduler(0.9, [...getScheduler(0.9).parameters.w])).not.toBe(getScheduler(0.9));
  });
});

describe('ts-fsrs behaviour this app relies on', () => {
  it('New + Good → Learning +10 min; next day Good → Review ≥ 1 d', async () => {
    await db.cards.add(newCardRecord('kana:あ', 'kana', 'read', NOW));
    const first = await gradeCard('kana:あ|read', Rating.Good, { durationMs: 3000, mode: 'typed', context: 'first-check', now: NOW });
    expect(first.state).toBe(State.Learning);
    expect(first.due.getTime() - NOW.getTime()).toBe(10 * MIN);
    const tomorrow = new Date(NOW.getTime() + DAY_MS);
    const second = await gradeCard('kana:あ|read', Rating.Good, { durationMs: 3000, mode: 'typed', now: tomorrow });
    expect(second.state).toBe(State.Review);
    expect(second.due.getTime() - tomorrow.getTime()).toBeGreaterThanOrEqual(DAY_MS);
  });

  it('Review + Again → Relearning; the re-ask Good → Review', async () => {
    await db.cards.add(reviewCard('word:1', 'word', 'read'));
    const missed = await gradeCard('word:1|read', Rating.Again, { durationMs: 5000, mode: 'typed', now: NOW });
    expect(missed.state).toBe(State.Relearning);
    expect(missed.due.getTime() - NOW.getTime()).toBe(10 * MIN);
    const later = new Date(NOW.getTime() + 3 * MIN);
    const reask = await gradeCard('word:1|read', Rating.Good, { durationMs: 4000, mode: 'typed', context: 're-ask', now: later });
    expect(reask.state).toBe(State.Review);
  });
});

describe('gradeCard', () => {
  it('logs kind, type, elapsed days and context, and counts the review for today', async () => {
    await db.cards.add(reviewCard('kanji:水', 'kanji', 'write', 7));
    await gradeCard('kanji:水|write', Rating.Hard, { durationMs: 4200, mode: 'written', input: 'stylus', override: true, now: NOW });
    const [log] = await db.reviewLogs.toArray();
    expect(log).toMatchObject({
      cardId: 'kanji:水|write', itemId: 'kanji:水', kind: 'kanji', type: 'write', grade: Rating.Hard, durationMs: 4200,
      mode: 'written', prevState: State.Review, elapsedDays: 7, context: 'review', input: 'stylus', override: true,
    });
    const day = await getDay('2026-10-14');
    expect(day).toMatchObject({ reviews: 1, correct: 1, studyMs: 4200, reviewMs: 4200 });
  });

  it('counts a first check in study time only, a re-ask as review time, and caps long answers', async () => {
    await db.cards.bulkAdd([newCardRecord('kana:あ', 'kana', 'read', NOW), reviewCard('word:1', 'word', 'read')]);
    await gradeCard('kana:あ|read', Rating.Again, { durationMs: 3000, mode: 'typed', context: 'first-check', now: NOW });
    await gradeCard('word:1|read', Rating.Good, { durationMs: 10 * MIN, mode: 'typed', context: 're-ask', now: NOW });
    const day = await getDay('2026-10-14');
    expect(day.reviews).toBe(2);
    expect(day.correct).toBe(1);
    expect(day.studyMs).toBe(3000 + MAX_COUNTED_ANSWER_MS);
    expect(day.reviewMs).toBe(MAX_COUNTED_ANSWER_MS);
    expect((await db.reviewLogs.where('cardId').equals('word:1|read').first())?.durationMs).toBe(10 * MIN);
  });

  it('adds no study time for a partner grade and puts make-up time in makeupMs', async () => {
    await db.cards.bulkAdd([reviewCard('word:1', 'word', 'read'), reviewCard('word:2', 'word', 'read')]);
    await gradeCard('word:1|read', Rating.Good, { durationMs: 5000, mode: 'partner', context: 'partner', now: NOW });
    await gradeCard('word:2|read', Rating.Good, { durationMs: 6000, mode: 'typed', makeup: true, now: NOW });
    const day = await getDay('2026-10-14');
    expect(day).toMatchObject({ reviews: 2, studyMs: 6000, reviewMs: 0, makeupMs: 6000 });
  });

  it('uses the receptive retention for read cards and 0.90 for write cards', async () => {
    await updateSettings({ receptiveRetention: 0.85 });
    await db.cards.bulkAdd([reviewCard('word:1', 'word', 'read', 10), reviewCard('kanji:水', 'kanji', 'write', 10)]);
    const read = await gradeCard('word:1|read', Rating.Good, { durationMs: 1, mode: 'typed', now: NOW });
    const write = await gradeCard('kanji:水|write', Rating.Good, { durationMs: 1, mode: 'written', now: NOW });
    // Same history, lower desired retention → a longer interval.
    expect(read.scheduled_days).toBeGreaterThan(write.scheduled_days);
  });

  it('joins an enclosing transaction over its tables', async () => {
    await db.cards.add(reviewCard('word:1', 'word', 'read'));
    await db.transaction('rw', [db.cards, db.reviewLogs, db.days, db.settings, db.items, db.encounters], async () => {
      await gradeCard('word:1|read', Rating.Good, { durationMs: 1000, mode: 'typed', now: NOW });
      await gradeCard('word:1|read', Rating.Good, { durationMs: 1000, mode: 'typed', context: 're-ask', now: NOW });
    });
    expect(await db.reviewLogs.count()).toBe(2);
  });

  it('rejects an unknown card', async () => {
    await expect(gradeCard('kana:x|read', Rating.Good, { durationMs: 1, mode: 'typed', now: NOW })).rejects.toThrow('unknown card');
  });
});

describe('previewDue and retrievability', () => {
  it('previews each grade in order', () => {
    const preview = previewDue(reviewCard('word:1', 'word', 'read'), NOW);
    expect(preview[1].getTime()).toBeLessThan(preview[3].getTime());
    expect(preview[3].getTime()).toBeLessThanOrEqual(preview[4].getTime());
  });

  it('is 1 for New cards and falls with time', () => {
    expect(retrievability(newCardRecord('kana:あ', 'kana', 'read', NOW), NOW)).toBe(1);
    const card = reviewCard('word:1', 'word', 'read', 10);
    const now = retrievability(card, NOW);
    const later = retrievability(card, new Date(NOW.getTime() + 20 * DAY_MS));
    expect(now).toBeGreaterThan(0.85);
    expect(now).toBeLessThan(0.95);
    expect(later).toBeLessThan(now);
  });
});

describe('partner window', () => {
  it('grades only within 2 days of due, never New or suspended cards', () => {
    expect(inPartnerWindow(reviewCard('word:1', 'word', 'read', 10, 3), NOW)).toBe(false);
    expect(inPartnerWindow(reviewCard('word:1', 'word', 'read', 10, 1), NOW)).toBe(true);
    expect(inPartnerWindow(reviewCard('word:1', 'word', 'read', 10, -2), NOW)).toBe(true);
    expect(inPartnerWindow(newCardRecord('word:1', 'word', 'read', NOW), NOW)).toBe(false);
    expect(inPartnerWindow({ ...reviewCard('kanji:水', 'kanji', 'write'), suspended: 'retired' }, NOW)).toBe(false);
  });

  it('maps verdicts to grades', () => {
    expect(PARTNER_GRADE).toEqual({ right: Rating.Good, close: Rating.Hard, wrong: Rating.Again });
  });
});
