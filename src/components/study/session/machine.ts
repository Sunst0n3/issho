// The study session as a pure step machine: which steps a plan has, in what
// order, and the per-card day-0 retrieval counter. No React, no IndexedDB, so
// the order and the cap can be tested on plain plans.

import type { CardType, SessionStepId } from '../../../lib/types.ts';
import type { NewItemPlan } from '../../../srs/course.ts';
import type { DayPlan } from '../../../srs/planner.ts';
import { shuffle } from '../../../srs/random.ts';

/** One item taught this sitting, with every card it created (upgrades: the one read card). */
export interface LearnedItem {
  plan: NewItemPlan;
  /** The item and, for a kanji, its anchor. */
  itemIds: string[];
  cardIds: string[];
  /** The card the memory pass retrieves (kanji/kana write, core produce, else core listen); none for grammar/staged. */
  memoryCardId?: string;
}

export interface SessionStep {
  id: SessionStepId;
  /** teach/memory: batch index */
  batch?: number;
}

/** Plans whose sitting is only the warm-up: the phone-only sitting and the short sessions offered on Today. */
const SHORT_MODES: ReadonlySet<DayPlan['mode']> = new Set(['micro', 'welcome-back']);

/** A batch item the memory pass retrieves: a kanji, a sprint kana or a core word. */
export function hasMemoryStep(item: Pick<NewItemPlan, 'kind'>): boolean {
  return item.kind === 'kanji' || item.kind === 'kana' || item.kind === 'core';
}

/**
 * Order: warmup → (teach b, memory b) for each batch → read → check → output → fluency → summary.
 * A step is included only when the plan has content for it: warmup (warmup.length), teach/memory (teach[b]),
 * read (read != null), check (cards created this sitting or plan.pendingCheck), output, fluency.
 * read/output/fluency in plan.doneSteps are skipped. 'anywhere' sitting and micro/welcome-back: warmup → summary.
 * A make-up has no teach, check or output; it keeps the reading and speed round its plan carries.
 * The memory step for batch b exists only when batch b has a kanji, sprint kana or core word.
 */
export function sessionSteps(plan: DayPlan): SessionStep[] {
  const steps: SessionStep[] = [];
  if (plan.warmup.length) steps.push({ id: 'warmup' });
  if (plan.sitting !== 'anywhere' && !SHORT_MODES.has(plan.mode)) {
    const done = new Set(plan.doneSteps);
    const makeup = plan.mode === 'makeup';
    let teaches = false;
    if (!makeup) {
      plan.teach.forEach((batch, b) => {
        if (!batch.items.length) return;
        teaches = true;
        steps.push({ id: 'teach', batch: b });
        if (batch.items.some(hasMemoryStep)) steps.push({ id: 'memory', batch: b });
      });
    }
    if (plan.read && !done.has('read')) steps.push({ id: 'read' });
    if (!makeup && (teaches || plan.pendingCheck.length)) steps.push({ id: 'check' });
    if (!makeup && plan.output && !done.has('output')) steps.push({ id: 'output' });
    if (plan.fluency && !done.has('fluency')) steps.push({ id: 'fluency' });
  }
  steps.push({ id: 'summary' });
  return steps;
}

export interface SessionState {
  steps: SessionStep[];
  index: number;
  /** Items taught this sitting (filled by 'taught'). */
  learned: LearnedItem[];
  /** First-check card ids, fixed when the check step starts. */
  checkIds: string[] | null;
  /** Day-0 retrievals per **card** id (memory → the production card, reading → the receptive card, first check, re-ask).
   *  React state only: lost on reload, which cannot break the cap (§3.1.7 "Steps and reloads"). */
  retrievals: Record<string, number>;
}

export type SessionEvent =
  | { type: 'next' }
  | { type: 'taught'; item: LearnedItem }
  | { type: 'retrieved'; cardId: string }
  | { type: 'start-check'; ids: string[] };

/** Per card. By construction a card reaches at most 3 (memory or reading, check, re-ask); a 'retrieved' event that would
 *  exceed 4 is ignored and the caller skips that retrieval. */
export const MAX_DAY0_RETRIEVALS = 4;

export function initialSession(plan: DayPlan): SessionState {
  return { steps: sessionSteps(plan), index: 0, learned: [], checkIds: null, retrievals: {} };
}

/** Whether one more day-0 retrieval of this card stays within the cap. */
export function canRetrieve(s: Pick<SessionState, 'retrievals'>, cardId: string): boolean {
  return (s.retrievals[cardId] ?? 0) < MAX_DAY0_RETRIEVALS;
}

export function sessionReducer(s: SessionState, e: SessionEvent): SessionState {
  switch (e.type) {
    case 'next':
      return s.index < s.steps.length - 1 ? { ...s, index: s.index + 1 } : s;
    case 'taught':
      // A repeat (a double tap, a remount) replaces the earlier copy rather than adding the item twice.
      return { ...s, learned: [...s.learned.filter((l) => l.plan.itemId !== e.item.plan.itemId), e.item] };
    case 'retrieved':
      if (!canRetrieve(s, e.cardId)) return s;
      return { ...s, retrievals: { ...s.retrievals, [e.cardId]: (s.retrievals[e.cardId] ?? 0) + 1 } };
    case 'start-check':
      return s.checkIds ? s : { ...s, checkIds: [...e.ids] };
  }
}

/** Production card types are asked first in the first check (recall before recognition). */
const PRODUCTION: ReadonlySet<CardType> = new Set<CardType>(['write', 'produce', 'build', 'cloze']);

const typeOfCard = (id: string) => id.slice(id.lastIndexOf('|') + 1) as CardType;

/** pure: every New card of the sitting (learned cardIds + pendingCheck, deduplicated): production types first (write,
 *  produce, build, cloze), then the rest (read, listen, comprehend, meaning); shuffled within each group with `random`. */
export function firstCheckIds(learned: readonly LearnedItem[], pendingCheck: readonly string[], random: () => number): string[] {
  const all = [...new Set([...learned.flatMap((l) => l.cardIds), ...pendingCheck])];
  const production = all.filter((id) => PRODUCTION.has(typeOfCard(id)));
  const rest = all.filter((id) => !PRODUCTION.has(typeOfCard(id)));
  return [...shuffle(production, random), ...shuffle(rest, random)];
}

/** The step name shown in the session header. */
export function stepLabel(step: SessionStep, plan: Pick<DayPlan, 'teach'>): string {
  switch (step.id) {
    case 'warmup': return 'Warm-up';
    case 'teach': {
      const batches = plan.teach.filter((b) => b.items.length).length;
      const at = plan.teach.slice(0, (step.batch ?? 0) + 1).filter((b) => b.items.length).length;
      return batches > 1 ? `New ${at} / ${batches}` : 'New';
    }
    case 'memory': return 'Memory';
    case 'read': return 'Read';
    case 'check': return 'Check';
    case 'output': return 'Sentence';
    case 'fluency': return 'Fluency';
    case 'summary': return 'Done';
  }
}
