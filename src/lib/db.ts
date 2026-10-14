import Dexie, { type EntityTable } from 'dexie';
import type {
  CardRecord,
  ChatMessageRecord,
  DayRecord,
  ItemRecord,
  OutboxRecord,
  ReviewLogRecord,
  SavedSentenceRecord,
  Settings,
} from './types.ts';

export class IsshoDB extends Dexie {
  items!: EntityTable<ItemRecord, 'id'>;
  cards!: EntityTable<CardRecord, 'id'>;
  reviewLogs!: EntityTable<ReviewLogRecord, 'id'>;
  days!: EntityTable<DayRecord, 'date'>;
  settings!: EntityTable<Settings, 'id'>;
  outbox!: EntityTable<OutboxRecord, 'clientId'>;
  messages!: EntityTable<ChatMessageRecord, 'id'>;
  savedSentences!: EntityTable<SavedSentenceRecord, 'id'>;

  constructor(name = 'issho') {
    super(name);
    this.version(1).stores({
      items: 'id, kind, introducedAt',
      cards: 'id, itemId, kind, type, due, state, suspended',
      reviewLogs: '++id, cardId, itemId, reviewedAt',
      days: 'date',
      settings: 'id',
      outbox: 'clientId, createdAt',
      messages: 'id, clientId, createdAt',
      savedSentences: 'id, savedAt',
    });
  }
}

export const db = new IsshoDB();

export const DEFAULT_SETTINGS: Settings = {
  id: 'me',
  name: '',
  onboarded: false,
  newPerDay: 5,
  desiredRetention: 0.9,
  maxReviewsPerDay: 120,
  furigana: 'unknown',
  romaji: true,
  audio: true,
  writingHand: 'finger',
  knowsHiragana: false,
  knowsKatakana: false,
  serverUrl: '',
};

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('me');
  return { ...DEFAULT_SETTINGS, ...s };
}

/** Merges `patch` into the stored settings. One transaction, so two quick changes can't both read the old row. */
export function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const next = { ...(await getSettings()), ...patch, id: 'me' as const };
    await db.settings.put(next);
    return next;
  });
}

/** Local calendar date key, 'YYYY-MM-DD'. A study day rolls over at 4 a.m. local time (DST-safe). */
export function dayKey(d: Date = new Date()): string {
  const shifted = new Date(d);
  if (shifted.getHours() < 4) shifted.setDate(shifted.getDate() - 1);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function itemId(kind: ItemRecord['kind'], key: string): string {
  return `${kind}:${key}`;
}

export function cardId(item: string, type: CardRecord['type']): string {
  return `${item}|${type}`;
}
