import Dexie, { type EntityTable, type Transaction } from 'dexie';
import type {
  CanDoRecord,
  CardRecord,
  ChatMessageRecord,
  DailyMinutes,
  DayRecord,
  EncounterRecord,
  FluencyLogRecord,
  ItemKind,
  ItemRecord,
  MilestoneRecord,
  OutboxRecord,
  OutputSentenceRecord,
  PartnerQuizRecord,
  PitchBoxRecord,
  RestTokenRecord,
  ReviewLogRecord,
  SavedSentenceRecord,
  SentenceShownRecord,
  Settings,
  StagedWordRecord,
  StoryProgressRecord,
  TogetherOutboxRecord,
  TogetherPlanRecord,
} from './types.ts';

/** Production cards (write, produce, build, cloze) always use this desired retention. */
export const PRODUCTION_RETENTION = 0.9;
/** Desired retentions offered for receptive cards (read, meaning, listen, comprehend). Never above 0.95. */
export const RECEPTIVE_RETENTIONS = [0.85, 0.88, 0.9, 0.93] as const;
export const DAILY_MINUTES: readonly DailyMinutes[] = [20, 25, 30, 40];
export const DEFAULT_WRITE_LIST = 500;
export const MAX_WRITE_LIST = 2136;

/** v1 progress tables the v2 upgrade empties: the course changed, so v1 progress does not carry over. */
export const PROGRESS_TABLES = ['items', 'cards', 'reviewLogs', 'days', 'savedSentences'] as const;

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

const V2_STORES = {
  items: 'id, kind, introducedAt',
  cards: 'id, itemId, kind, type, due, state',
  reviewLogs: '++id, cardId, itemId, reviewedAt, [type+reviewedAt]',
  days: 'date',
  settings: 'id',
  outbox: 'clientId, createdAt',
  messages: 'id, clientId, createdAt',
  savedSentences: 'id, savedAt',
  encounters: '++id, itemId, day, [itemId+day]',
  shownSentences: 'id, day',
  staged: 'itemId, releaseDay',
  stories: 'storyId, nextDay',
  restTokens: 'date, week',
  outputs: 'id, day, check',
  canDos: 'id, unit',
  milestones: 'id',
  togetherPlans: 'week',
  togetherOutbox: 'clientId, createdAt',
  partnerQuizzes: 'quizId',
  pitchBoxes: 'ref, nextDay',
  fluency: '++id, kind, day',
};

export class IsshoDB extends Dexie {
  items!: EntityTable<ItemRecord, 'id'>;
  cards!: EntityTable<CardRecord, 'id'>;
  reviewLogs!: EntityTable<ReviewLogRecord, 'id'>;
  days!: EntityTable<DayRecord, 'date'>;
  settings!: EntityTable<Settings, 'id'>;
  outbox!: EntityTable<OutboxRecord, 'clientId'>;
  messages!: EntityTable<ChatMessageRecord, 'id'>;
  savedSentences!: EntityTable<SavedSentenceRecord, 'id'>;
  encounters!: EntityTable<EncounterRecord, 'id'>;
  shownSentences!: EntityTable<SentenceShownRecord, 'id'>;
  staged!: EntityTable<StagedWordRecord, 'itemId'>;
  stories!: EntityTable<StoryProgressRecord, 'storyId'>;
  restTokens!: EntityTable<RestTokenRecord, 'date'>;
  outputs!: EntityTable<OutputSentenceRecord, 'id'>;
  canDos!: EntityTable<CanDoRecord, 'id'>;
  milestones!: EntityTable<MilestoneRecord, 'id'>;
  togetherPlans!: EntityTable<TogetherPlanRecord, 'week'>;
  togetherOutbox!: EntityTable<TogetherOutboxRecord, 'clientId'>;
  partnerQuizzes!: EntityTable<PartnerQuizRecord, 'quizId'>;
  pitchBoxes!: EntityTable<PitchBoxRecord, 'ref'>;
  fluency!: EntityTable<FluencyLogRecord, 'id'>;

  constructor(name = 'issho') {
    super(name);
    this.version(1).stores(V1_STORES);
    this.version(2).stores(V2_STORES).upgrade(upgradeToV2);
  }
}

export const db = new IsshoDB();

export const DEFAULT_SETTINGS: Settings = {
  id: 'me',
  name: '',
  onboarded: false,
  dailyMinutes: 25,
  writeList: DEFAULT_WRITE_LIST,
  receptiveRetention: 0.9,
  furigana: 'unknown',
  audio: true,
  writingHand: 'finger',
  handsBusy: false,
  justShowMe: false,
  knowsHiragana: false,
  knowsKatakana: false,
  togetherSlots: [],
  planReviewDays: [],
  shareAccuracy: false,
  serverUrl: '',
};

/** Fields a v1 settings row keeps in v2; everything else is reset. */
const KEPT_V1_KEYS = [
  'name', 'furigana', 'audio', 'ttsVoice', 'writingHand',
  'serverUrl', 'deviceToken', 'memberId', 'householdName', 'lastPairing',
] as const;

/** v1 newPerDay → v2 dailyMinutes: 3 → 20, 5 → 25, 8 → 30 (≤ 3 → 20, 4–6 → 25, ≥ 7 → 30; missing → 25). */
export function minutesForOldPace(newPerDay: unknown): DailyMinutes {
  const pace = typeof newPerDay === 'number' && Number.isFinite(newPerDay) ? newPerDay : 5;
  return pace <= 3 ? 20 : pace <= 6 ? 25 : 30;
}

/**
 * A v1 settings row as v2 Settings. Learning progress is reset by the upgrade, so onboarding runs
 * again (the name and the pairing are kept and pre-filled); romaji, newPerDay, maxReviewsPerDay and
 * desiredRetention are dropped; knowsHiragana/knowsKatakana go back to false (placement decides).
 */
export function migrateSettings(old: Readonly<Record<string, unknown>>): Settings {
  const kept: Record<string, unknown> = {};
  for (const key of KEPT_V1_KEYS) if (old[key] !== undefined) kept[key] = old[key];
  return {
    ...DEFAULT_SETTINGS,
    ...(kept as Partial<Settings>),
    id: 'me',
    onboarded: false,
    dailyMinutes: minutesForOldPace(old.newPerDay),
  };
}

/** The nearest offered receptive retention (so never above 0.95); 0.9 for nonsense. */
export function normalizeRetention(value: number): number {
  if (!Number.isFinite(value)) return 0.9;
  let best: number = RECEPTIVE_RETENTIONS[0];
  for (const r of RECEPTIVE_RETENTIONS) if (Math.abs(r - value) < Math.abs(best - value)) best = r;
  return best;
}

/** Dexie upgrade 1 → 2: empties the progress tables, migrates settings, drops the old localStorage key. */
export async function upgradeToV2(tx: Transaction): Promise<void> {
  for (const name of PROGRESS_TABLES) await tx.table(name).clear();
  await tx.table('settings').toCollection().modify((row: Record<string, unknown>, ctx: { value: unknown }) => {
    ctx.value = migrateSettings(row);
  });
  try {
    localStorage.removeItem('issho.srs.sentencesShown');
  } catch {
    // Storage blocked: nothing to remove.
  }
}

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

const ITEM_KINDS: readonly ItemKind[] = ['kana', 'kanaRule', 'kanji', 'word', 'core', 'grammar', 'sentence'];

/** 'kanji:水' → { kind: 'kanji', key: '水' }; null when the kind is unknown. */
export function parseItemId(id: string): { kind: ItemKind; key: string } | null {
  const at = id.indexOf(':');
  const kind = id.slice(0, at) as ItemKind;
  return at > 0 && ITEM_KINDS.includes(kind) ? { kind, key: id.slice(at + 1) } : null;
}

/** 'kanji:水|write' → 'kanji:水'. */
export function itemIdOfCard(id: string): string {
  return id.slice(0, id.lastIndexOf('|'));
}
