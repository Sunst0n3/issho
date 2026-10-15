import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, IsshoDB, migrateSettings, minutesForOldPace, normalizeRetention, PROGRESS_TABLES } from './db.ts';

/** The v1 schema exactly as shipped (db.ts keeps it private). */
const V1_STORES = {
  items: 'id, kind, introducedAt',
  cards: 'id, itemId, kind, type, due, state, suspended',
  reviewLogs: '++id, cardId, itemId, reviewedAt',
  days: 'date',
  settings: 'id',
  outbox: 'clientId, createdAt',
  messages: 'id, clientId, createdAt',
  savedSentences: 'id, savedAt',
};

const NAME = 'issho-upgrade-test';
const t = new Date('2026-09-01T09:00:00Z');

afterEach(async () => {
  await Dexie.delete(NAME);
});

const card = (itemId: string, kind: string, type: string) => ({
  id: `${itemId}|${type}`, itemId, kind, type, due: t, stability: 3, difficulty: 5, elapsed_days: 0, scheduled_days: 3,
  learning_steps: 0, reps: 2, lapses: 0, state: 2, last_review: t,
});

async function makeV1Database(): Promise<void> {
  const old = new Dexie(NAME);
  old.version(1).stores(V1_STORES);
  await old.open();
  await old.table('items').bulkAdd([
    { id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: t },
    { id: 'radical:亻', kind: 'radical', key: '亻', introducedAt: t },
    { id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: t },
    { id: 'word:1', kind: 'word', key: '1', introducedAt: t },
    { id: 'vocab:sw-ai', kind: 'vocab', key: 'sw-ai', introducedAt: t },
    { id: 'grammar:g-wa', kind: 'grammar', key: 'g-wa', introducedAt: t },
    { id: 'sentence:s-1', kind: 'sentence', key: 's-1', introducedAt: t },
  ]);
  await old.table('cards').bulkAdd([
    card('kana:あ', 'kana', 'read'), card('kana:あ', 'kana', 'write'), card('radical:亻', 'radical', 'meaning'),
    card('kanji:水', 'kanji', 'meaning'), card('kanji:水', 'kanji', 'reading'), card('kanji:水', 'kanji', 'write'),
    card('word:1', 'word', 'reading'), card('word:1', 'word', 'meaning'), card('vocab:sw-ai', 'vocab', 'meaning'),
    card('vocab:sw-ai', 'vocab', 'recall'), card('grammar:g-wa', 'grammar', 'drill'), card('sentence:s-1', 'sentence', 'read'),
  ]);
  await old.table('reviewLogs').bulkAdd([
    { cardId: 'kanji:水|write', itemId: 'kanji:水', grade: 3, reviewedAt: t, durationMs: 4000, mode: 'written', prevState: 2 },
  ]);
  await old.table('days').bulkAdd([{ date: '2026-09-01', studyMs: 600_000, reviews: 10, correct: 9, newItems: 3, sessionComplete: true }]);
  await old.table('savedSentences').bulkAdd([{ id: 's-1', jp: '{水|みず}', en: 'water', savedAt: t }]);
  await old.table('settings').put({
    id: 'me', name: 'Carter', onboarded: true, newPerDay: 5, romaji: true, maxReviewsPerDay: 120, desiredRetention: 0.9,
    knowsHiragana: true, knowsKatakana: true, furigana: 'always', audio: false, writingHand: 'stylus',
    serverUrl: 'http://home:8787', deviceToken: 'device-token', memberId: 'm1', householdName: 'Home',
    lastPairing: { householdId: 'h1', memberId: 'm1', serverUrl: 'http://home:8787' },
  });
  await old.table('messages').bulkAdd([1, 2, 3].map((id) => ({ id, clientId: `c${id}`, memberId: 'm1', createdAt: '2026-09-01T09:00:00Z', kind: 'text', text: `hi ${id}` })));
  await old.table('outbox').bulkAdd([
    { clientId: 'o1', createdAt: t, kind: 'text', text: 'later', attempts: 0 },
    { clientId: 'o2', createdAt: t, kind: 'text', text: 'later too', attempts: 2 },
  ]);
  old.close();
}

describe('Dexie v1 → v2 upgrade', () => {
  it('empties progress, migrates settings and keeps pairing, chat and outbox', async () => {
    await makeV1Database();
    localStorage.setItem('issho.srs.sentencesShown', JSON.stringify({ 's-1': '2026-09-01' }));
    const db = new IsshoDB(NAME);
    await db.open();
    try {
      for (const name of PROGRESS_TABLES) expect(await db.table(name).count(), name).toBe(0);
      const settings = (await db.settings.get('me')) as unknown as Record<string, unknown>;
      expect(settings).toMatchObject({
        id: 'me', name: 'Carter', onboarded: false, dailyMinutes: 25, knowsHiragana: false, knowsKatakana: false,
        furigana: 'always', audio: false, writingHand: 'stylus', serverUrl: 'http://home:8787', deviceToken: 'device-token',
        memberId: 'm1', householdName: 'Home', lastPairing: { householdId: 'h1', memberId: 'm1', serverUrl: 'http://home:8787' },
        writeList: 500, receptiveRetention: 0.9,
      });
      for (const key of ['romaji', 'newPerDay', 'maxReviewsPerDay', 'desiredRetention']) expect(settings).not.toHaveProperty(key);
      expect((await db.messages.toArray()).map((m) => m.text)).toEqual(['hi 1', 'hi 2', 'hi 3']);
      expect((await db.outbox.toArray()).map((o) => [o.clientId, o.attempts])).toEqual([['o1', 0], ['o2', 2]]);
      expect(localStorage.getItem('issho.srs.sentencesShown')).toBeNull();
      // The new tables exist and work.
      await db.encounters.add({ itemId: 'kana:あ', day: '2026-09-02', source: 'sentence', at: t });
      expect(await db.encounters.where('[itemId+day]').equals(['kana:あ', '2026-09-02']).count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('starts a fresh device with the defaults', async () => {
    const db = new IsshoDB(NAME);
    await db.open();
    try {
      expect(await db.settings.count()).toBe(0);
      expect(db.tables.map((tbl) => tbl.name).sort()).toEqual([
        'canDos', 'cards', 'days', 'encounters', 'fluency', 'items', 'messages', 'milestones', 'outbox', 'outputs',
        'partnerQuizzes', 'pitchBoxes', 'restTokens', 'reviewLogs', 'savedSentences', 'settings', 'shownSentences',
        'staged', 'stories', 'togetherOutbox', 'togetherPlans',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('settings migration helpers', () => {
  it('maps the old daily pace to minutes', () => {
    expect(minutesForOldPace(3)).toBe(20);
    expect(minutesForOldPace(5)).toBe(25);
    expect(minutesForOldPace(8)).toBe(30);
    expect(minutesForOldPace(undefined)).toBe(25);
  });

  it('snaps a retention to the offered values, never above 0.95', () => {
    expect(normalizeRetention(0.97)).toBe(0.93);
    expect(normalizeRetention(0.8)).toBe(0.85);
    expect(normalizeRetention(0.89)).toBe(0.88);
    expect(normalizeRetention(Number.NaN)).toBe(0.9);
  });

  it('keeps only the v1 fields that still mean the same', () => {
    expect(migrateSettings({ id: 'me', name: 'A', newPerDay: 8, romaji: true })).toEqual({ ...DEFAULT_SETTINGS, name: 'A', dailyMinutes: 30 });
  });
});
