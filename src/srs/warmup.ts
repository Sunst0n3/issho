// Warm-up order and sibling rules (pure). Re-exported by planner.ts; kept in
// its own module so the simulator can use it without the DB-backed planner.

import { State } from 'ts-fsrs';
import type { CardRecord, CardType } from '../lib/types.ts';
import { hashString } from './random.ts';

export interface WarmupCard {
  id: string;
  itemId: string;
  type: CardType;
  state: State;
  r: number;
  due: Date;
  /** Day key the card's item was introduced. */
  introducedDay: string;
  groups: string[];
  value: 0 | 1 | 2;
}

/** In catch-up, cards sharing a sibling group are kept at least this many positions apart when possible. */
export const CATCH_UP_SPACING = 10;

/**
 * pure: sibling groups of a card: `item:<itemId>`; kanji write → `k:<char>`; word/core cards → `k:<c>` for
 * each kanji c of the word. At most one card per group is reviewed on a day.
 */
export function siblingGroups(card: Pick<CardRecord, 'itemId' | 'kind' | 'type'>, wordKanji: readonly string[]): string[] {
  const groups = [`item:${card.itemId}`];
  if (card.kind === 'kanji' && card.type === 'write') groups.push(`k:${card.itemId.slice(card.itemId.indexOf(':') + 1)}`);
  if (card.kind === 'word' || card.kind === 'core') for (const c of wordKanji) groups.push(`k:${c}`);
  return groups;
}

function rank(card: WarmupCard, yesterday: string | null): number {
  const learning = card.state === State.Learning || card.state === State.Relearning;
  if (learning) return yesterday !== null && card.introducedDay === yesterday ? 0 : 1;
  return card.state === State.Review ? 2 : 3;
}

/**
 * Retrievability and due times are compared in coarse steps: cards learned or reviewed together (a kana row, a lesson
 * batch) differ only by the seconds between their answers, so exact values would replay yesterday's order, which is
 * chart order. Within a step the order is a per-day shuffle, so the sequence gives no cue.
 */
export const R_STEP = 0.01;
export const DUE_STEP_MS = 60 * 60 * 1000;

const rStep = (r: number) => Math.round(r / R_STEP);
const dueStep = (d: Date) => Math.floor(d.getTime() / DUE_STEP_MS);

/** pure: the priority order before sibling rules. Ties are broken by a hash of the seed and the card id. */
function sorted(cards: readonly WarmupCard[], yesterday: string | null, seed: string): WarmupCard[] {
  const shuffled = new Map(cards.map((c) => [c.id, hashString(`${seed}|${c.id}`)]));
  return [...cards].sort((a, b) => {
    const ra = rank(a, yesterday);
    const rb = rank(b, yesterday);
    if (ra !== rb) return ra - rb;
    const tie = shuffled.get(a.id)! - shuffled.get(b.id)! || a.id.localeCompare(b.id);
    if (ra < 2) return dueStep(a.due) - dueStep(b.due) || tie;
    return rStep(a.r) - rStep(b.r) || b.value - a.value || dueStep(a.due) - dueStep(b.due) || tie;
  });
}

/** Greedy deferral: each next position takes the first card whose groups were not used in the last 9 positions. */
function spaced(cards: readonly WarmupCard[]): string[] {
  const remaining = [...cards];
  const lastAt = new Map<string, number>();
  const order: string[] = [];
  while (remaining.length) {
    const pos = order.length;
    let pick = remaining.findIndex((c) => c.groups.every((g) => (lastAt.get(g) ?? -Infinity) <= pos - CATCH_UP_SPACING));
    if (pick < 0) pick = 0;
    const [card] = remaining.splice(pick, 1);
    for (const g of card.groups) lastAt.set(g, pos);
    order.push(card.id);
  }
  return order;
}

/**
 * pure. Order: Learning/Relearning cards introduced yesterday (by due), other Learning/Relearning (by due),
 * then Review by ascending r (ties: value desc, due asc), r and due in coarse steps (R_STEP, DUE_STEP_MS) and
 * remaining ties shuffled by `seed` (the day key: the same order all day, a different one tomorrow). Not catch-up:
 * a card whose group is in takenGroups (reviewed earlier today) or already taken in this order is buried. Catch-up:
 * nothing is buried; cards sharing a group are kept ≥ 10 positions apart when possible (greedy deferral).
 */
export function orderWarmup(
  cards: readonly WarmupCard[],
  opts: { yesterday: string | null; takenGroups: ReadonlySet<string>; catchUp: boolean; seed?: string },
): { order: string[]; bury: string[] } {
  const queue = sorted(cards, opts.yesterday, opts.seed ?? '');
  if (opts.catchUp) return { order: spaced(queue), bury: [] };
  const taken = new Set(opts.takenGroups);
  const order: string[] = [];
  const bury: string[] = [];
  for (const card of queue) {
    if (card.groups.some((g) => taken.has(g))) {
      bury.push(card.id);
      continue;
    }
    for (const g of card.groups) taken.add(g);
    order.push(card.id);
  }
  return { order, bury };
}
