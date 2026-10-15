// The output step: one sentence a day to the partner, built around a recent word
// or grammar point, checked by the AI (prompt, then reveal), and turned into a
// cloze card only when the card guard passes.

import { dayKey, db } from '../lib/db.ts';
import { loadGrammarIndex, loadWordInfo } from '../lib/data.ts';
import { isKanji } from '../lib/ruby.ts';
import type { AiCheckResponse, AiLearnerContext } from '../../shared/api.ts';
import type { ItemRecord, OutputSentenceRecord, OutputTarget } from '../lib/types.ts';
import { loadCourseSnapshot } from './course.ts';
import { daysBetween } from './days.ts';
import { loadKnownWords } from './readListen.ts';
import { createGuardedCloze } from './sentenceGuard.ts';

/** A grammar point is the target every 3rd study day. */
export const GRAMMAR_TARGET_EVERY = 3;
export const GRAMMAR_TARGET_AGE = [1, 14] as const;
export const WORD_TARGET_AGE = [1, 7] as const;
export const KNOWN_WORDS_MAX = 3000;

async function outputEncounterCounts(ids: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  for (const e of await db.encounters.where('itemId').anyOf([...ids]).toArray()) {
    if (e.source === 'output') counts.set(e.itemId, (counts.get(e.itemId) ?? 0) + 1);
  }
  return counts;
}

function ageIn(item: ItemRecord, today: string, [from, to]: readonly [number, number]): boolean {
  const age = daysBetween(dayKey(item.introducedAt), today);
  return age >= from && age <= to;
}

/** Fewest 'output' encounters first, then the most recently introduced. */
async function leastPractised(items: readonly ItemRecord[]): Promise<ItemRecord | undefined> {
  const counts = await outputEncounterCounts(items.map((i) => i.id));
  return [...items].sort(
    (a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || b.introducedAt.getTime() - a.introducedAt.getTime(),
  )[0];
}

/**
 * null until the sprint is over (sprintComplete && courseDay ≥ kanjiFrom). Every 3rd study day: a grammar point
 * introduced 1–14 days ago (not recognitionOnly); otherwise a word introduced 1–7 days ago with use = true (core or
 * JMdict), fewest 'output' encounters first. The label is the word as the learner knows it (kana until spelled) or
 * the grammar pattern. When the day's kind has no candidate, the other kind is used.
 */
export async function pickOutputTarget(now: Date = new Date()): Promise<OutputTarget | null> {
  const snapshot = await loadCourseSnapshot(now);
  if (!snapshot.sprintComplete || snapshot.courseDay < snapshot.gates.kanjiFrom) return null;
  const today = snapshot.today;
  const [grammarIndex, info, items] = await Promise.all([
    loadGrammarIndex(),
    loadWordInfo(),
    db.items.where('kind').anyOf('grammar', 'word', 'core').toArray(),
  ]);

  const grammarTarget = async (): Promise<OutputTarget | null> => {
    const pool = items.filter(
      (i) => i.kind === 'grammar' && ageIn(i, today, GRAMMAR_TARGET_AGE) && !grammarIndex.get(i.key)?.recognitionOnly,
    );
    const pick = await leastPractised(pool);
    const point = pick && grammarIndex.get(pick.key);
    return pick && point ? { ref: pick.id, label: point.pattern, en: point.title } : null;
  };
  const wordTarget = async (): Promise<OutputTarget | null> => {
    const pool = items.filter((i) => (i.kind === 'word' || i.kind === 'core') && ageIn(i, today, WORD_TARGET_AGE) && info(i.id)?.use);
    const pick = await leastPractised(pool);
    const word = pick && info(pick.id);
    if (!pick || !word) return null;
    const spelled = pick.kind === 'word' || pick.spelledAt !== undefined;
    const written = spelled && [...word.written].some(isKanji) ? `{${word.written}|${word.kana}}` : word.kana;
    return { ref: pick.id, label: written, en: word.en };
  };

  const grammarDay = snapshot.courseDay % GRAMMAR_TARGET_EVERY === 0;
  return grammarDay ? ((await grammarTarget()) ?? (await wordTarget())) : ((await wordTarget()) ?? (await grammarTarget()));
}

/**
 * Saves the day's sentence. Idempotent (a double tap or a StrictMode re-run): the same send, identified by its chat
 * clientId (or, without one, by the same draft and text that day), is stored once and the stored row is returned.
 */
export function saveOutput(rec: Omit<OutputSentenceRecord, 'id' | 'createdAt'>, now: Date = new Date()): Promise<OutputSentenceRecord> {
  return db.transaction('rw', db.outputs, async () => {
    const sameDay = await db.outputs.where('day').equals(rec.day).toArray();
    const existing = sameDay.find((o) =>
      rec.chatClientId ? o.chatClientId === rec.chatClientId : !o.chatClientId && o.text === rec.text && o.draft === rec.draft,
    );
    if (existing) return existing;
    const row: OutputSentenceRecord = { ...rec, id: crypto.randomUUID(), createdAt: now };
    await db.outputs.add(row);
    return row;
  });
}

/** Checks still waiting for the AI (check 'pending'), oldest first. F's sync retries them when the server is reachable. */
export async function pendingOutputChecks(): Promise<OutputSentenceRecord[]> {
  const rows = await db.outputs.where('check').equals('pending').toArray();
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Stores the reveal result; runs the guard; on success creates the cloze card and returns its id. Idempotent. */
export async function completeOutputCheck(id: string, result: AiCheckResponse, now: Date = new Date()): Promise<{ cardId?: string }> {
  const row = await db.outputs.get(id);
  if (!row) throw new Error(`Unknown output sentence "${id}"`);
  if (row.check === 'done' && row.cardId) return { cardId: row.cardId };

  const corrected = result.corrected || (result.ok ? row.text : '');
  let cardId: string | undefined;
  if (corrected) {
    cardId =
      (await createGuardedCloze(
        { corrected, en: row.target.en, words: result.words, grammarUsed: result.grammarUsed, target: row.target.ref },
        'correction',
        now,
      )) ?? undefined;
  }
  await db.outputs.update(id, {
    check: 'done',
    issues: result.issues,
    corrected: result.correctedRuby || corrected || undefined,
    rule: result.rule,
    ...(cardId ? { cardId } : {}),
  });
  return cardId ? { cardId } : {};
}

/** The learner's AI context (known kanji, grammar ids, known words as written, register 'plain'). */
export async function learnerAiContext(now: Date = new Date()): Promise<AiLearnerContext> {
  const [items, known, info] = await Promise.all([db.items.toArray(), loadKnownWords(now), loadWordInfo()]);
  const knownWords: string[] = [];
  for (const item of items) {
    if (knownWords.length >= KNOWN_WORDS_MAX) break;
    if ((item.kind === 'word' || item.kind === 'core') && known.isKnown(item.id)) {
      const word = info(item.id);
      if (!word) continue;
      knownWords.push(item.kind === 'core' && !item.spelledAt ? word.kana : word.written);
    }
  }
  return {
    knownKanji: items.filter((i) => i.kind === 'kanji').map((i) => i.key),
    knownGrammar: items.filter((i) => i.kind === 'grammar').map((i) => i.key),
    knownWords,
    register: 'plain',
  };
}
