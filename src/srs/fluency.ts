// The 2-minute fluency slot: the pitch-ear drill on Mon/Wed/Fri, and on
// Tue/Thu/Sat a rotation of timed re-read → 60-s speed round → numbers drill.
// Nothing here is graded into FSRS.

import { dayKey, db } from '../lib/db.ts';
import { loadAccent, loadAudioManifest, loadWordInfo } from '../lib/data.ts';
import type { FluencyKind } from '../lib/types.ts';
import { daysBetween, isoWeekday } from './days.ts';
import { COUNTERS, NUMBER_DRILL_GRAMMAR, numbersDrill, type Counter, type NumberDrillItem } from './numbersDrill.ts';
import { pickPitchDrill, pitchCandidates, PITCH_DRILL_MIN } from './pitch.ts';
import type { DayMode, FluencyPlan } from './planner.ts';
import { seededRandom, shuffle } from './random.ts';
import { loadKnownWords } from './readListen.ts';

/** pure: ISO weekday 1 Mon, 3 Wed, 5 Fri → 'pitch'; 2 Tue, 4 Thu, 6 Sat → 'rotation'; 7 Sun → null. */
export function fluencyKindFor(isoWeekday: number): 'pitch' | 'rotation' | null {
  if (isoWeekday === 7) return null;
  return isoWeekday % 2 === 1 ? 'pitch' : 'rotation';
}

const ROTATION = ['reread', 'speed', 'numbers'] as const;

/** pure: reread → speed → numbers → reread …, skipping ineligible kinds. */
export function nextRotation(
  last: FluencyKind | undefined,
  eligible: { reread: boolean; speed: boolean; numbers: boolean },
): 'reread' | 'speed' | 'numbers' | null {
  const at = ROTATION.indexOf(last as (typeof ROTATION)[number]);
  for (let step = 1; step <= ROTATION.length; step++) {
    const kind = ROTATION[(at + step + ROTATION.length) % ROTATION.length];
    if (eligible[kind]) return kind;
  }
  return null;
}

export const FLUENCY_MIN_STRAND = 6;
export const FLUENCY_MINUTES = 2;
/** The read block keeps at least this many minutes next to output (1) and fluency (2). */
export const READ_MIN_MINUTES = 3;
export const SPEED_ROUND_MS = 60_000;
export const SPEED_ROUND_MAX = 40;
export const SPEED_ROUND_MIN_CARDS = 20;
export const SPEED_STABILITY_DAYS = 21;
export const REREAD_AGE = [7, 21] as const;

const NO_FLUENCY: ReadonlySet<DayMode> = new Set<DayMode>(['catch-up', 'travel', 'micro', 'welcome-back', 'makeup']);

/** pure: whether the slot can run at all today (before eligibility). */
export function fluencySlotOpen(strandMin: number, mode: DayMode, isoDay: number): boolean {
  if (NO_FLUENCY.has(mode) || fluencyKindFor(isoDay) === null) return false;
  return strandMin >= FLUENCY_MIN_STRAND && strandMin - 1 - FLUENCY_MINUTES >= READ_MIN_MINUTES;
}

/** Receptive cards with stability > 21 d (read, listen, meaning, kana read), random, max 40. Never graded. */
export async function speedRoundCards(now: Date = new Date(), max = SPEED_ROUND_MAX): Promise<string[]> {
  const lists = await Promise.all((['read', 'listen', 'meaning'] as const).map((type) => db.cards.where('type').equals(type).toArray()));
  const ids = lists.flat().filter((c) => !c.suspended && c.stability > SPEED_STABILITY_DAYS).map((c) => c.id);
  return shuffle(ids.sort(), seededRandom(`speed|${dayKey(now)}`)).slice(0, max);
}

/** Counters, time and prices whose grammar is introduced (only known material is drilled). */
export async function numbersDrillScope(): Promise<{ counters: Counter[]; time: boolean; prices: boolean }> {
  const grammar = new Set((await db.items.where('kind').equals('grammar').primaryKeys()).map((k) => String(k).slice(8)));
  return {
    counters: COUNTERS.filter((c) => grammar.has(NUMBER_DRILL_GRAMMAR.counters[c])),
    time: grammar.has(NUMBER_DRILL_GRAMMAR.time),
    prices: grammar.has(NUMBER_DRILL_GRAMMAR.prices),
  };
}

/** Today's numbers drill (seeded by the day, so a re-plan gives the same items). */
export async function numbersDrillToday(now: Date = new Date()): Promise<NumberDrillItem[]> {
  return numbersDrill(seededRandom(`numbers|${dayKey(now)}`), await numbersDrillScope());
}

/** The story due for a timed re-read: first read 7–21 days ago, ladder stage 1–2. */
async function rereadStory(today: string): Promise<string | undefined> {
  const rows = await db.stories.toArray();
  return rows
    .filter((p) => p.stage >= 1 && p.stage < 3 && p.firstDay !== undefined)
    .filter((p) => {
      const age = daysBetween(p.firstDay!, today);
      return age >= REREAD_AGE[0] && age <= REREAD_AGE[1];
    })
    .sort((a, b) => a.firstDay!.localeCompare(b.firstDay!))[0]?.storyId;
}

/**
 * null on Sundays, in catch-up/travel/micro/make-up plans, when strandMin < 6 (before about course day 61), and
 * whenever strandMin − 1 (output) − 2 < 3 (the read block keeps ≥ 3 min). pitch is eligible with ≥ 8 pitch items
 * (pitchCandidates); reread with a story at stage ≥ 1 first read 7–21 days ago and stage < 3; speed with ≥ 20
 * receptive cards of stability > 21 d; numbers once 'numbers-prices' is introduced. If today's kind is ineligible,
 * another eligible kind is used.
 */
export async function pickFluency(ctx: { strandMin: number; mode: DayMode }, now: Date = new Date()): Promise<FluencyPlan | null> {
  const today = dayKey(now);
  const weekday = isoWeekday(today);
  if (!fluencySlotOpen(ctx.strandMin, ctx.mode, weekday)) return null;

  const [accent, manifest, info, known, speedCards, storyId, scope, lastLog, boxRows] = await Promise.all([
    loadAccent(),
    loadAudioManifest(),
    loadWordInfo(),
    loadKnownWords(now),
    speedRoundCards(now),
    rereadStory(today),
    numbersDrillScope(),
    db.fluency.where('kind').anyOf('reread', 'speed', 'numbers').sortBy('at').then((rows) => rows.at(-1)),
    db.pitchBoxes.toArray(),
  ]);
  const pitchItems = pitchCandidates(accent, manifest, known.isKnown, info);
  const eligible = {
    pitch: pitchItems.length >= PITCH_DRILL_MIN,
    reread: storyId !== undefined,
    speed: speedCards.length >= SPEED_ROUND_MIN_CARDS,
    numbers: scope.prices,
  };

  const plan = (kind: FluencyKind): FluencyPlan => {
    switch (kind) {
      case 'pitch': {
        const boxes = new Map(boxRows.map((b) => [b.ref, b]));
        return { kind, pitch: pickPitchDrill(pitchItems, boxes, today, seededRandom(`pitch|${today}`)) };
      }
      case 'reread':
        return { kind, storyId };
      case 'speed':
        return { kind, cardIds: speedCards };
      case 'numbers':
        return { kind, numbers: numbersDrill(seededRandom(`numbers|${today}`), scope) };
    }
  };

  const rotation = nextRotation(lastLog?.kind, eligible);
  if (fluencyKindFor(weekday) === 'pitch') {
    if (eligible.pitch) return plan('pitch');
    return rotation ? plan(rotation) : null;
  }
  if (rotation) return plan(rotation);
  return eligible.pitch ? plan('pitch') : null;
}

export async function logFluency(kind: FluencyKind, value: number, ref?: string, now: Date = new Date()): Promise<void> {
  await db.fluency.add({ kind, day: dayKey(now), at: now, value, ...(ref ? { ref } : {}) });
}
