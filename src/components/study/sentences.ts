// Saved sentences: saving one from reading makes it a cloze card that blanks one word (the sentence's target).

import { db } from '../../lib/db.ts';
import { loadSentences } from '../../lib/data.ts';
import { rubyToPlain } from '../../lib/ruby.ts';
import type { RubyText, SavedSentenceRecord, SentenceEntry, WordRef } from '../../lib/types.ts';
import { toHiragana } from '../../srs/answers.ts';
import { introduceItem } from '../../srs/items.ts';

/** Saving sentences as cloze cards is open from the first course day. */
export const SAVE_FROM_COURSE_DAY = 1;

/** The word a cloze card of `sentence` blanks: the target's surface (first occurrence) and its reading. */
export function blankFor(sentence: Pick<SentenceEntry, 'jp' | 'tokens'>, target: WordRef): SavedSentenceRecord['blank'] | null {
  const token = sentence.tokens.find((t) => t.ref === target);
  if (!token || !rubyToPlain(sentence.jp).includes(token.s)) return null;
  return { surface: token.s, reading: toHiragana(token.r ?? token.s), ref: target };
}

/** Saves the sentence with its target blanked and introduces its cloze card. Saving again changes nothing. */
export async function saveSentence(
  s: Pick<SentenceEntry, 'id' | 'jp' | 'en' | 'tokens'>,
  target: WordRef,
  source: 'reading' | 'story' = 'reading',
  now: Date = new Date(),
): Promise<boolean> {
  const blank = blankFor(s, target);
  if (!blank) return false;
  await db.transaction('rw', [db.savedSentences, db.items, db.cards, db.days, db.settings], async () => {
    if (await db.savedSentences.get(s.id)) return;
    const record: SavedSentenceRecord = { id: s.id, jp: s.jp as RubyText, en: s.en, savedAt: now, source, blank };
    await db.savedSentences.put(record);
    await introduceItem('sentence', s.id, now, { via: 'saved' });
  });
  return true;
}

/** Course sentences by id, in the order given; unknown ids are dropped. */
export async function sentencesById(ids: readonly string[]): Promise<SentenceEntry[]> {
  const byId = new Map((await loadSentences()).map((s) => [s.id, s]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}
