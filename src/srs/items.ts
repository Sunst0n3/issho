// Learnable items and their cards: introducing new items and marking items the
// learner already knows.

import { State } from 'ts-fsrs';
import { cardId, dayKey, db, itemId } from '../lib/db.ts';
import type { CardRecord, CardType, ItemKind, ItemRecord } from '../lib/types.ts';
import { DAY_MS, updateDay } from './days.ts';
import { hashString } from './random.ts';
import { newCardRecord } from './scheduler.ts';

/** Yōon (きゃ, キョ) are combinations of a kana and a small ya/yu/yo. */
export function isYoon(kana: string): boolean {
  return /[ゃゅょャュョ]/.test(kana);
}

export function cardTypesFor(kind: ItemKind, key: string): CardType[] {
  switch (kind) {
    case 'kana':
      return isYoon(key) ? ['read'] : ['read', 'write'];
    case 'radical':
      return ['meaning'];
    case 'kanji':
      return ['meaning', 'reading', 'write'];
    case 'word':
      return ['reading', 'meaning'];
    case 'vocab':
      return ['meaning', 'recall'];
    case 'grammar':
      return ['drill'];
    case 'sentence':
      return ['read'];
  }
}

/**
 * Whether introducing this kind uses up the day's new-item allowance. Words
 * arrive together with their kanji unit, and saved sentences come from reading.
 */
export function countsAsNew(kind: ItemKind): boolean {
  return kind !== 'word' && kind !== 'sentence';
}

export interface IntroduceResult {
  item: ItemRecord;
  /** All of the item's cards, in cardTypesFor order. */
  cards: CardRecord[];
  /** False when the item had already been introduced. */
  created: boolean;
}

/**
 * Creates the item and its cards. Idempotent: an item that already exists is
 * left alone (apart from adding any card types it is missing) and is not
 * counted as new again.
 */
export function introduceItem(kind: ItemKind, key: string, now: Date = new Date()): Promise<IntroduceResult> {
  return db.transaction('rw', db.items, db.cards, db.days, async () => {
    const id = itemId(kind, key);
    const existing = await db.items.get(id);
    const item: ItemRecord = existing ?? { id, kind, key, introducedAt: now };
    if (!existing) await db.items.add(item);

    const cards = await ensureCards(item, now);
    if (!existing && countsAsNew(kind)) {
      await updateDay(dayKey(now), (day) => {
        day.newItems += 1;
      });
    }
    return { item, cards, created: !existing };
  });
}

async function ensureCards(item: ItemRecord, now: Date): Promise<CardRecord[]> {
  const types = cardTypesFor(item.kind, item.key);
  const found = await db.cards.bulkGet(types.map((type) => cardId(item.id, type)));
  const cards = types.map((type, i) => found[i] ?? newCardRecord(item.id, item.kind, type, now));
  const missing = cards.filter((_, i) => !found[i]);
  if (missing.length) await db.cards.bulkAdd(missing);
  return cards;
}

export interface ItemRef {
  kind: ItemKind;
  key: string;
}

/** Marks one item as already known; see markKnownMany. */
export function markKnown(kind: ItemKind, key: string, now: Date = new Date()): Promise<void> {
  return markKnownMany([{ kind, key }], now);
}

/**
 * Introduces the items (without counting them as new today) and moves their
 * not-yet-graduated cards straight to Review, due 1–14 days out so a large batch
 * (e.g. all of hiragana) comes back as a gentle trickle of check-ups.
 */
export function markKnownMany(refs: readonly ItemRef[], now: Date = new Date()): Promise<void> {
  return db.transaction('rw', db.items, db.cards, async () => {
    const ids = refs.map((r) => itemId(r.kind, r.key));
    const existing = await db.items.bulkGet(ids);
    const newItems = refs
      .filter((_, i) => !existing[i])
      .map((r): ItemRecord => ({ id: itemId(r.kind, r.key), kind: r.kind, key: r.key, introducedAt: now }));
    // The same ref listed twice must not trip bulkAdd's uniqueness check.
    await db.items.bulkPut(newItems);

    const wanted = refs.flatMap((r) =>
      cardTypesFor(r.kind, r.key).map((type) => ({ item: itemId(r.kind, r.key), kind: r.kind, type })),
    );
    const cards = await db.cards.bulkGet(wanted.map((w) => cardId(w.item, w.type)));
    const known = wanted.flatMap((w, i) => {
      const card = cards[i];
      if (card && (card.state === State.Review || card.state === State.Relearning)) return [];
      return [knownCard(card ?? newCardRecord(w.item, w.kind, w.type, now), now)];
    });
    await db.cards.bulkPut(known);
  });
}

/** Stability (days) given to cards of items the learner says they already know. */
export const KNOWN_STABILITY_DAYS = 14;
const KNOWN_DIFFICULTY = 4;

/** A day offset in 1..14, stable per card, used to spread known cards out. */
export function knownDueOffsetDays(id: string): number {
  return 1 + (hashString(id) % 14);
}

export function knownCard(card: CardRecord, now: Date): CardRecord {
  const days = knownDueOffsetDays(card.id);
  return {
    ...card,
    state: State.Review,
    due: new Date(now.getTime() + days * DAY_MS),
    stability: KNOWN_STABILITY_DAYS,
    difficulty: KNOWN_DIFFICULTY,
    scheduled_days: days,
    elapsed_days: 0,
    learning_steps: 0,
    reps: Math.max(card.reps, 1),
    last_review: now,
  };
}

export async function isIntroduced(id: string): Promise<boolean> {
  return (await db.items.get(id)) !== undefined;
}
