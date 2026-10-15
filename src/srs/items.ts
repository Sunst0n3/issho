// Learnable items and their cards: introducing items, the core-word spelling
// upgrade, the placement shortcut, and write-card retirement past the write list.

import { State } from 'ts-fsrs';
import { cardId, db, getSettings, itemId } from '../lib/db.ts';
import { loadCurriculum } from '../lib/data.ts';
import type { CardRecord, CardType, ItemKind, ItemRecord } from '../lib/types.ts';
import { DAY_MS } from './days.ts';
import { hashString } from './random.ts';
import { newCardRecord } from './scheduler.ts';

export interface CardTypeContext {
  /** kanji: no taught word (51 kanji) → add 'meaning'. */
  zeroWord?: boolean;
  /** word/core: produce card. */
  use?: boolean;
  /** core: spelled with kanji (read card). */
  spelled?: boolean;
  /** grammar: comprehend only. */
  recognitionOnly?: boolean;
}

/** pure: the cards an item has (see the table in src/lib/types.ts). Production cards come first where both exist. */
export function cardTypesFor(kind: ItemKind, _key: string, ctx: CardTypeContext = {}): CardType[] {
  switch (kind) {
    case 'kana':
      return ['read', 'write'];
    case 'kanaRule':
      return ['read'];
    case 'kanji':
      return ctx.zeroWord ? ['write', 'meaning'] : ['write'];
    case 'word':
      return ctx.use ? ['read', 'produce'] : ['read'];
    case 'core':
      return ['listen', ...(ctx.use ? ['produce' as const] : []), ...(ctx.spelled ? ['read' as const] : [])];
    case 'grammar':
      return ctx.recognitionOnly ? ['comprehend'] : ['comprehend', 'build'];
    case 'sentence':
      return ['cloze'];
  }
}

/** Whether introducing this kind counts as a new item for the day (saved sentences come from reading). */
export function countsAsNew(kind: ItemKind): boolean {
  return kind !== 'sentence';
}

export interface IntroduceResult {
  item: ItemRecord;
  /** The cards of this introduction (all of the item's cards for an item; the read card for a spelling upgrade). */
  cards: CardRecord[];
  /** True when this call created the item (for a spelling upgrade: when it created the read card). */
  created: boolean;
}

async function ensureCards(item: ItemRecord, types: readonly CardType[], now: Date): Promise<{ cards: CardRecord[]; added: number }> {
  const found = await db.cards.bulkGet(types.map((type) => cardId(item.id, type)));
  const cards = types.map((type, i) => found[i] ?? newCardRecord(item.id, item.kind, type, now));
  const missing = cards.filter((_, i) => !found[i]);
  if (missing.length) await db.cards.bulkAdd(missing);
  return { cards, added: missing.length };
}

/**
 * Creates the item and its cards in one transaction. Idempotent: an item that already exists is
 * left alone apart from adding any card types its context now calls for. DayRecord accounting is
 * done by the caller (course.ts introducePlanItem), and only when `created`.
 */
export function introduceItem(
  kind: ItemKind,
  key: string,
  now: Date = new Date(),
  opts: { ctx?: CardTypeContext; via?: ItemRecord['via'] } = {},
): Promise<IntroduceResult> {
  return db.transaction('rw', db.items, db.cards, async () => {
    const id = itemId(kind, key);
    const existing = await db.items.get(id);
    let item: ItemRecord;
    if (existing) {
      item = existing;
    } else {
      item = { id, kind, key, introducedAt: now, via: opts.via ?? 'lesson' };
      if (kind === 'core' && opts.ctx?.spelled) item.spelledAt = now;
      await db.items.add(item);
    }
    const { cards } = await ensureCards(item, cardTypesFor(kind, key, opts.ctx), now);
    return { item, cards, created: !existing };
  });
}

/**
 * The core spelling upgrade: a core word met in kana is now taught with its kanji (as a kanji's
 * anchor or staged word). Adds the word's read card (idempotent) and sets spelledAt the first
 * time. `created` is true when the read card was created by this call.
 */
export function upgradeSpelling(coreId: string, now: Date = new Date()): Promise<IntroduceResult> {
  return db.transaction('rw', db.items, db.cards, async () => {
    const id = itemId('core', coreId);
    const existing = await db.items.get(id);
    if (!existing) throw new Error(`Cannot upgrade the spelling of "${id}": it is not introduced`);
    const { cards, added } = await ensureCards(existing, ['read'], now);
    let item = existing;
    if (added && !existing.spelledAt) {
      item = { ...existing, spelledAt: now };
      await db.items.put(item);
    }
    return { item, cards, created: added > 0 };
  });
}

export interface ItemRef2 {
  kind: ItemKind;
  key: string;
  ctx?: CardTypeContext;
}

/** Difficulty given to cards of items the placement check found known. */
const KNOWN_DIFFICULTY = 4;

/** A day offset in 1..spread, stable per card, so a batch of known cards comes back as a trickle. */
export function knownDueOffsetDays(id: string, spread: number): number {
  return 1 + (hashString(id) % Math.max(1, Math.round(spread)));
}

/** A card moved straight to Review with the given stability (placement). */
export function knownCard(card: CardRecord, now: Date, stabilityDays: number): CardRecord {
  const days = knownDueOffsetDays(card.id, stabilityDays);
  return {
    ...card,
    state: State.Review,
    due: new Date(now.getTime() + days * DAY_MS),
    stability: stabilityDays,
    difficulty: KNOWN_DIFFICULTY,
    scheduled_days: days,
    elapsed_days: 0,
    learning_steps: 0,
    reps: Math.max(card.reps, 1),
    last_review: now,
  };
}

/**
 * Placement: introduces the items (via 'placement', not counted as new today) and moves their
 * cards that are not yet in Review straight to Review with the given stability, due spread over
 * 1..stabilityDays days.
 */
export function markKnownMany(refs: readonly ItemRef2[], now: Date = new Date(), stabilityDays = 10): Promise<void> {
  return db.transaction('rw', db.items, db.cards, async () => {
    const ids = refs.map((r) => itemId(r.kind, r.key));
    const existing = await db.items.bulkGet(ids);
    const fresh = new Map<string, ItemRecord>();
    refs.forEach((r, i) => {
      if (!existing[i]) fresh.set(ids[i], { id: ids[i], kind: r.kind, key: r.key, introducedAt: now, via: 'placement' });
    });
    // The same ref listed twice must not trip bulkAdd's uniqueness check.
    await db.items.bulkPut([...fresh.values()]);

    const wanted = refs.flatMap((r) =>
      cardTypesFor(r.kind, r.key, r.ctx).map((type) => ({ item: itemId(r.kind, r.key), kind: r.kind, type })),
    );
    const cards = await db.cards.bulkGet(wanted.map((w) => cardId(w.item, w.type)));
    const known = new Map<string, CardRecord>();
    wanted.forEach((w, i) => {
      const card = cards[i];
      if (card && (card.state === State.Review || card.state === State.Relearning)) return;
      const next = knownCard(card ?? newCardRecord(w.item, w.kind, w.type, now), now, stabilityDays);
      known.set(next.id, next);
    });
    await db.cards.bulkPut([...known.values()]);
  });
}

export const RETIRE_STABILITY_DAYS = 21;

/** pure: a kanji write card past the write list, not pinned, and stable beyond 21 days retires. */
export function shouldRetire(
  card: Pick<CardRecord, 'stability' | 'type' | 'kind'>,
  rank: number,
  writeList: number,
  pinned: boolean,
): boolean {
  return card.kind === 'kanji' && card.type === 'write' && rank > writeList && !pinned && card.stability > RETIRE_STABILITY_DAYS;
}

/** Curriculum rank (1-based) of each kanji. */
async function kanjiRanks(): Promise<Map<string, number>> {
  const curriculum = await loadCurriculum();
  return new Map(curriculum.units.map((u) => [u.char, u.index + 1]));
}

function withRetirement(card: CardRecord, retire: boolean): CardRecord | null {
  if (retire && card.suspended !== 'retired') return { ...card, suspended: 'retired' };
  if (!retire && card.suspended === 'retired') {
    const { suspended: _suspended, ...rest } = card;
    return rest;
  }
  return null;
}

/**
 * Retires (suspended 'retired', never deleted) or restores every kanji write card for the current
 * write list and pins. Runs at sitting start and after a Settings change. Returns the changes.
 */
export async function syncWriteRetirement(_now: Date = new Date()): Promise<{ retired: number; restored: number }> {
  const ranks = await kanjiRanks();
  const { writeList } = await getSettings();
  return db.transaction('rw', db.items, db.cards, async () => {
    const [items, cards] = await Promise.all([
      db.items.where('kind').equals('kanji').toArray(),
      db.cards.where('kind').equals('kanji').toArray().then((all) => all.filter((c) => c.type === 'write')),
    ]);
    const pinned = new Set(items.filter((i) => i.pinned).map((i) => i.id));
    let retired = 0;
    let restored = 0;
    const changed: CardRecord[] = [];
    for (const card of cards) {
      const char = card.itemId.slice('kanji:'.length);
      const rank = ranks.get(char) ?? Number.POSITIVE_INFINITY;
      const next = withRetirement(card, shouldRetire(card, rank, writeList, pinned.has(card.itemId)));
      if (!next) continue;
      changed.push(next);
      if (next.suspended) retired++;
      else restored++;
    }
    if (changed.length) await db.cards.bulkPut(changed);
    return { retired, restored };
  });
}

/** Keeps a kanji on (or takes it off) the handwriting list beyond Settings.writeList. */
export async function setPinned(char: string, pinned: boolean): Promise<void> {
  const ranks = await kanjiRanks();
  const { writeList } = await getSettings();
  await db.transaction('rw', db.items, db.cards, async () => {
    const id = itemId('kanji', char);
    const item = await db.items.get(id);
    if (!item) return;
    await db.items.put({ ...item, pinned });
    const card = await db.cards.get(cardId(id, 'write'));
    if (!card) return;
    const next = withRetirement(card, shouldRetire(card, ranks.get(char) ?? Number.POSITIVE_INFINITY, writeList, pinned));
    if (next) await db.cards.put(next);
  });
}

export async function isIntroduced(id: string): Promise<boolean> {
  return (await db.items.get(id)) !== undefined;
}
