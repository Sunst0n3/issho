// Read & listen: which words the learner knows, i+1 study sentences, graded
// stories (coverage, ladder) and the read block's plan within its minutes.

import { clipRef } from '../../shared/voicevox.ts';
import { dayKey, db, getSettings } from '../lib/db.ts';
import { loadAudioManifest, loadSentences, loadStories } from '../lib/data.ts';
import type {
  AudioManifest,
  PreToken,
  SentenceEntry,
  StoryEntry,
  StoryLevel,
  StoryProgressRecord,
  WordRef,
} from '../lib/types.ts';
import { courseDay } from './course.ts';
import { addDays, daysBetween } from './days.ts';
import { encounterCounts, ENCOUNTER_TARGET, logEncounters } from './encounters.ts';
import type { ReadPlan } from './planner.ts';

export interface KnownWords {
  /** Introduced, and its read card (word, spelled core) or listen card (core) has a log with grade ≥ 2. */
  isKnown(ref: string): boolean;
  /** Day key introduced, if introduced. */
  introducedDay(ref: string): string | undefined;
}

/** pure: a KnownWords over plain sets (tests, the simulator, devSeed). */
export function knownWordsFrom(introduced: ReadonlyMap<string, string>, known: ReadonlySet<string>): KnownWords {
  return {
    isKnown: (ref) => introduced.has(ref) && known.has(ref),
    introducedDay: (ref) => introduced.get(ref),
  };
}

export async function loadKnownWords(now: Date = new Date()): Promise<KnownWords> {
  const items = await db.items.where('kind').anyOf('word', 'core').toArray();
  const introduced = new Map(items.map((i) => [i.id, dayKey(i.introducedAt)]));
  const known = new Set<string>();
  // Two plain range reads: a multi-range cursor is far slower than getAll on these sizes.
  const [words, cores] = await Promise.all([
    db.reviewLogs.where('itemId').startsWith('word:').toArray(),
    db.reviewLogs.where('itemId').startsWith('core:').toArray(),
  ]);
  for (const log of [...words, ...cores]) {
    if (log.grade >= 2 && (log.type === 'read' || log.type === 'listen') && log.reviewedAt <= now) known.add(log.itemId);
  }
  return knownWordsFrom(introduced, known);
}

export const EASY_COVERAGE = 0.98;
export const STRETCH_COVERAGE = 0.95;

/** pure: content = tokens with k === 'c' and not name; known = those with a ref that isKnown; ratio = known/content (1 when content = 0). */
export function coverage(tokens: readonly PreToken[], isKnown: (ref: string) => boolean): { content: number; known: number; ratio: number } {
  let content = 0;
  let known = 0;
  for (const t of tokens) {
    if (t.k !== 'c' || t.name) continue;
    content++;
    if (t.ref && isKnown(t.ref)) known++;
  }
  return { content, known, ratio: content ? known / content : 1 };
}

export function storyCoverage(story: StoryEntry, isKnown: (ref: string) => boolean): number {
  return coverage(story.sentences.flatMap((s) => s.tokens), isKnown).ratio;
}

export interface IPlusOneContext {
  known: KnownWords;
  grammarKnown: ReadonlySet<string>;
  today: string;
  encounters: ReadonlyMap<string, number>;
  /** Shown in the last 7 days. */
  resting: ReadonlySet<string>;
}

export interface PickedSentence { id: string; target: WordRef }

/** Days after its introduction a word can be a sentence's target. */
export const TARGET_AGE = [1, 21] as const;

/** pure: the sentence's target when it qualifies (see pickIPlusOne), else null. */
function sentenceTarget(sentence: SentenceEntry, ctx: IPlusOneContext): WordRef | null {
  if (ctx.resting.has(sentence.id)) return null;
  if (!sentence.grammar.every((g) => ctx.grammarKnown.has(g))) return null;
  const refs: WordRef[] = [];
  for (const t of sentence.tokens) {
    if (t.k !== 'c' || t.name) continue;
    if (!t.ref) return null;
    if (!refs.includes(t.ref)) refs.push(t.ref);
  }
  let target: WordRef | null = null;
  let fewest = Infinity;
  for (const ref of refs) {
    const day = ctx.known.introducedDay(ref);
    if (day === undefined) continue;
    const age = daysBetween(day, ctx.today);
    if (age < TARGET_AGE[0] || age > TARGET_AGE[1]) continue;
    const n = ctx.encounters.get(ref) ?? 0;
    if (n < fewest) {
      fewest = n;
      target = ref;
    }
  }
  if (!target) return null;
  return refs.every((ref) => ref === target || ctx.known.isKnown(ref)) ? target : null;
}

/**
 * pure. A sentence qualifies when: not resting; every grammar tag is introduced; every content token (non-name) has a ref;
 * exactly one target is chosen among its refs introduced 1–21 days ago (the one with the fewest encounters);
 * every other content ref is known. Ranking: target encounters < 8 first (ascending), then file order.
 * Distinct targets across the picks.
 */
export function pickIPlusOne(sentences: readonly SentenceEntry[], ctx: IPlusOneContext, n: number): PickedSentence[] {
  if (n <= 0) return [];
  const ranked: { id: string; target: WordRef; encounters: number; index: number }[] = [];
  sentences.forEach((sentence, index) => {
    const target = sentenceTarget(sentence, ctx);
    if (target) ranked.push({ id: sentence.id, target, encounters: ctx.encounters.get(target) ?? 0, index });
  });
  ranked.sort((a, b) => {
    const starvedA = a.encounters < ENCOUNTER_TARGET;
    const starvedB = b.encounters < ENCOUNTER_TARGET;
    if (starvedA !== starvedB) return starvedA ? -1 : 1;
    if (starvedA && a.encounters !== b.encounters) return a.encounters - b.encounters;
    return a.index - b.index;
  });
  const out: PickedSentence[] = [];
  const targets = new Set<string>();
  for (const r of ranked) {
    if (out.length >= n) break;
    if (targets.has(r.target)) continue;
    targets.add(r.target);
    out.push({ id: r.id, target: r.target });
  }
  return out;
}

/** A known sentence that contains the ref and whose other words are known (carrier phrase / feedback example). */
export function exampleSentenceFor(ref: string, sentences: readonly SentenceEntry[], known: KnownWords): SentenceEntry | undefined {
  return sentences.find((s) => {
    if (!s.refs.includes(ref as WordRef)) return false;
    return s.tokens.every((t) => t.k !== 'c' || t.name || (t.ref !== undefined && (t.ref === ref || known.isKnown(t.ref))));
  });
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const STORY_LADDER = { listen: 3, reread: 10 } as const;
/** Grammar readiness is separate from lexical coverage, which excludes function words. */
export function storyGrammarKnown(story: StoryEntry, grammarKnown: ReadonlySet<string>): boolean {
  return story.grammar.every((g) => grammarKnown.has(g));
}

export interface StoryPick { storyId: string; step: 'rwl' | 'listen'; shared: boolean }

const LEVEL_RANK: Record<StoryLevel, number> = { start: 0, L0: 1, L1: 2 };

function byLevel(a: StoryEntry, b: StoryEntry): number {
  return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.unit - b.unit || a.id.localeCompare(b.id);
}

/**
 * pure. Priority: (1) a 'listen' step due (stage 1, nextDay ≤ today); (2) the shared weekly story at stage 0
 * with coverage ≥ 0.98 and all grammar introduced; (3) a stage-0 story with the same gates, by level (start, L0, L1), unit, id. Never below 0.98.
 */
export function pickStory(
  stories: readonly StoryEntry[],
  ctx: { isKnown: (ref: string) => boolean; grammarKnown: ReadonlySet<string>; progress: ReadonlyMap<string, StoryProgressRecord>; today: string; sharedStoryId?: string },
): StoryPick | null {
  const shared = (id: string) => id === ctx.sharedStoryId;
  const listen = stories
    .filter((s) => {
      const p = ctx.progress.get(s.id);
      return p?.stage === 1 && p.nextDay !== undefined && p.nextDay <= ctx.today;
    })
    .sort((a, b) => (ctx.progress.get(a.id)!.nextDay!).localeCompare(ctx.progress.get(b.id)!.nextDay!) || byLevel(a, b));
  if (listen.length) return { storyId: listen[0].id, step: 'listen', shared: shared(listen[0].id) };

  const fresh = (s: StoryEntry) => (ctx.progress.get(s.id)?.stage ?? 0) === 0 && storyGrammarKnown(s, ctx.grammarKnown) && storyCoverage(s, ctx.isKnown) >= EASY_COVERAGE;
  const sharedStory = ctx.sharedStoryId ? stories.find((s) => s.id === ctx.sharedStoryId) : undefined;
  if (sharedStory && fresh(sharedStory)) return { storyId: sharedStory.id, step: 'rwl', shared: true };
  const next = [...stories].sort(byLevel).find(fresh);
  return next ? { storyId: next.id, step: 'rwl', shared: shared(next.id) } : null;
}

/** pure: coverage in [0.95, 0.98) — offered in the Library with tap glosses. */
export function stretchStories(stories: readonly StoryEntry[], isKnown: (ref: string) => boolean): StoryEntry[] {
  return stories.filter((s) => {
    const c = storyCoverage(s, isKnown);
    return c >= STRETCH_COVERAGE && c < EASY_COVERAGE;
  });
}

export const READY_STORIES_MAX = 60;

/** Stories at ≥ 98 % with every grammar tag introduced (MemberProgress.readyStories, max 60). */
export async function readyStoryIds(now: Date = new Date()): Promise<string[]> {
  const [stories, known, grammarKnown] = await Promise.all([loadStories(), loadKnownWords(now), grammarIntroduced()]);
  return [...stories]
    .sort(byLevel)
    .filter((s) => storyGrammarKnown(s, grammarKnown) && storyCoverage(s, known.isKnown) >= EASY_COVERAGE)
    .slice(0, READY_STORIES_MAX)
    .map((s) => s.id);
}

const STEP_STAGE = { rwl: 1, listen: 2, reread: 3 } as const;

/**
 * Advances the ladder: rwl → stage 1 (firstDay = today, nextDay = firstDay + 3), listen → stage 2 (nextDay =
 * firstDay + 10), reread → stage 3; logs story encounters. Idempotent per (story, step, day).
 */
export async function recordStoryStep(
  storyId: string,
  step: 'rwl' | 'listen' | 'reread',
  result: { gistCorrect?: boolean; cpm?: number },
  now: Date = new Date(),
): Promise<void> {
  const today = dayKey(now);
  const stories = await loadStories();
  const story = stories.find((s) => s.id === storyId);
  const advanced = await db.transaction('rw', db.stories, async () => {
    const row: StoryProgressRecord = (await db.stories.get(storyId)) ?? { storyId, stage: 0, gist: [], cpm: [] };
    if (row.stage >= STEP_STAGE[step]) return false;
    const next: StoryProgressRecord = { ...row, gist: [...row.gist], cpm: [...row.cpm], stage: STEP_STAGE[step] };
    if (step === 'rwl') {
      next.firstDay = today;
      next.nextDay = addDays(today, STORY_LADDER.listen);
    } else if (step === 'listen') {
      next.nextDay = addDays(next.firstDay ?? today, STORY_LADDER.reread);
    } else {
      delete next.nextDay;
    }
    if (result.gistCorrect !== undefined) next.gist.push(result.gistCorrect);
    if (result.cpm !== undefined && Number.isFinite(result.cpm)) next.cpm.push(result.cpm);
    await db.stories.put(next);
    return true;
  });
  if (advanced && story) await logEncounters(story.refs, step === 'reread' ? 'fluency' : 'story', now);
}

// ---------------------------------------------------------------------------
// The read block
// ---------------------------------------------------------------------------

/** Spoken length of a story sentence without a generated clip, per character. */
const MS_PER_CHAR = 180;
export const SENTENCE_MINUTES = 1;
export const GIST_MINUTES = 1;
export const STORY_MIN_MINUTES = 2;

/** Audio playback rate: Settings.audioRate, else 0.85 up to course day 90, then 1. */
export function audioRateFor(audioRate: number | undefined, day: number): number {
  return audioRate && audioRate > 0 ? audioRate : day <= 90 ? 0.85 : 1;
}

/** pure: Σ clip ms / rate / 60 000 + 1 min for the gist, at least 2. */
export function storyMinutes(story: StoryEntry, manifest: AudioManifest, rate: number): number {
  let ms = 0;
  story.sentences.forEach((sentence, n) => {
    const clip = manifest.clips[manifest.byRef[clipRef.story(story.id, n)] ?? ''];
    ms += clip ? clip.ms : sentence.tokens.reduce((s, t) => s + t.s.length, 0) * MS_PER_CHAR;
  });
  return Math.max(STORY_MIN_MINUTES, ms / rate / 60_000 + GIST_MINUTES);
}

/** Sentence ids shown in the last 7 days. */
export const RESTING_DAYS = 7;

async function restingSentences(today: string): Promise<Set<string>> {
  const since = addDays(today, -(RESTING_DAYS - 1));
  return new Set((await db.shownSentences.where('day').aboveOrEqual(since).toArray()).map((r) => r.id));
}

export async function grammarIntroduced(): Promise<Set<string>> {
  const keys = await db.items.where('kind').equals('grammar').primaryKeys();
  return new Set(keys.map((k) => String(k).slice('grammar:'.length)));
}

/** The i+1 context for today (resting sentences can be ignored, as the make-up session does). */
export async function iPlusOneContext(now: Date, opts: { ignoreResting?: boolean } = {}): Promise<IPlusOneContext> {
  const today = dayKey(now);
  const [known, grammarKnown, encounters, resting] = await Promise.all([
    loadKnownWords(now),
    grammarIntroduced(),
    encounterCounts(undefined, now),
    opts.ignoreResting ? Promise.resolve(new Set<string>()) : restingSentences(today),
  ]);
  return { known, grammarKnown, today, encounters, resting };
}

/**
 * Fits the plan into `minutes` (never more): a story when one qualifies and its estimate (Σ clip ms / rate / 60 000
 * + 1 min for the gist, at least 2) fits, then sentences (≈ 1 min each) in the minutes left, at most 1 with a story;
 * without a story, min(floor(minutes), courseDay ≤ 60 ? 2 : 3) sentences (at least 1). ReadPlan.minutes = the estimate
 * in whole minutes. The planner fills the minutes this leaves with recent words (planner.ts READ_WORD_SECONDS).
 */
export async function pickRead(opts: { minutes: number; sharedStoryId?: string }, now: Date = new Date()): Promise<ReadPlan> {
  const today = dayKey(now);
  const [stories, sentences, manifest, settings, day, ctx, progressRows] = await Promise.all([
    loadStories(),
    loadSentences(),
    loadAudioManifest(),
    getSettings(),
    courseDay(now),
    iPlusOneContext(now),
    db.stories.toArray(),
  ]);
  const plan: ReadPlan = { kind: 'sentences', kanaWords: [], sentences: [], minutes: 0 };
  const pick = pickStory(stories, {
    isKnown: ctx.known.isKnown,
    grammarKnown: ctx.grammarKnown,
    progress: new Map(progressRows.map((p) => [p.storyId, p])),
    today,
    sharedStoryId: opts.sharedStoryId,
  });
  const story = pick ? stories.find((s) => s.id === pick.storyId) : undefined;
  if (pick && story) {
    const estimate = storyMinutes(story, manifest, audioRateFor(settings.audioRate, day));
    if (estimate <= opts.minutes) {
      plan.kind = 'story';
      plan.story = pick;
      // Whole minutes, as Today shows them ("3 min read & listen"), when that still fits.
      const whole = Math.ceil(estimate - 1e-9);
      plan.minutes = whole <= opts.minutes ? whole : estimate;
    }
  }
  const slots = plan.story
    ? Math.min(1, Math.floor((opts.minutes - plan.minutes) / SENTENCE_MINUTES))
    : Math.max(1, Math.min(Math.floor(opts.minutes / SENTENCE_MINUTES), day <= 60 ? 2 : 3));
  plan.sentences = pickIPlusOne(sentences, ctx, slots).map((p) => ({ id: p.id, target: p.target }));
  plan.minutes += plan.sentences.length * SENTENCE_MINUTES;
  return plan;
}

/** Records that these sentences were shown today, so they rest for a week. Idempotent per day. */
export async function markSentencesShown(ids: readonly string[], now: Date = new Date()): Promise<void> {
  const today = dayKey(now);
  await db.transaction('rw', db.shownSentences, async () => {
    const rows = await db.shownSentences.bulkGet([...ids]);
    const next = ids.map((id, i) => {
      const row = rows[i];
      if (row?.day === today) return row;
      return { id, day: today, count: (row?.count ?? 0) + 1 };
    });
    await db.shownSentences.bulkPut(next);
  });
}

/** Forgets which sentences were shown, so none are resting (also drops the v1 localStorage copy). */
export async function resetReadingMemory(): Promise<void> {
  await db.shownSentences.clear();
  try {
    localStorage.removeItem('issho.srs.sentencesShown');
  } catch {
    // Storage blocked: nothing to remove.
  }
}
