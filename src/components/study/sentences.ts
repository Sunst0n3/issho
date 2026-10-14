// Saved sentences: saving one from reading makes it a self-graded 'read' card.

import { cardId, db, itemId } from '../../lib/db.ts';
import { loadSentences } from '../../lib/data.ts';
import type { SentenceEntry } from '../../lib/types.ts';
import { introduceItem } from '../../srs/items.ts';

export type SentenceLike = Pick<SentenceEntry, 'id' | 'jp' | 'en'>;

const readCardId = (id: string) => cardId(itemId('sentence', id), 'read');

export async function saveSentence(s: SentenceLike, now: Date = new Date()): Promise<void> {
  await db.transaction('rw', db.savedSentences, db.items, db.cards, db.days, async () => {
    await db.savedSentences.put({ id: s.id, jp: s.jp, en: s.en, savedAt: now });
    await introduceItem('sentence', s.id, now);
    // Saved again after being removed: its card comes back.
    await db.cards.update(readCardId(s.id), { suspended: false });
  });
}

/** Removes a saved sentence and stops reviewing it (its history is kept). */
export async function unsaveSentence(id: string): Promise<void> {
  await db.transaction('rw', db.savedSentences, db.cards, async () => {
    await db.savedSentences.delete(id);
    await db.cards.update(readCardId(id), { suspended: true });
  });
}

/** Sentences by id, from the saved copies first, then the course sentences; unknown ids are dropped. */
export async function sentencesById(ids: readonly string[]): Promise<SentenceLike[]> {
  const [saved, all] = await Promise.all([db.savedSentences.bulkGet([...ids]), loadSentences()]);
  const byId = new Map(all.map((s) => [s.id, s]));
  return ids.flatMap((id, i) => {
    const s = saved[i] ?? byId.get(id);
    return s ? [{ id: s.id, jp: s.jp, en: s.en }] : [];
  });
}
