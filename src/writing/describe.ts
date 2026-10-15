// Plain-English words for strokes and stroke mistakes, for feedback lines such
// as "Next: a short stroke, top right, sweeping down-left."

import type { StrokeAttempt, UnorderedMatch } from './matcher.ts';
import { BOX, distance, flattenPath, pathLength, polylineLength, type Point } from './path.ts';

const SHORT_STROKE = 25;
const LONG_STROKE = 70;

function region(p: Point): string {
  const third = BOX / 3;
  const row = p.y < third ? 'top' : p.y > 2 * third ? 'bottom' : 'middle';
  const col = p.x < third ? 'left' : p.x > 2 * third ? 'right' : '';
  if (!col) return row === 'middle' ? 'centre' : row;
  return `${row} ${col}`;
}

const HEADINGS = [
  // [from angle, long wording, short wording]; 0° = right, 90° = down (screen coordinates).
  [-22.5, 'left to right', 'right'],
  [22.5, 'down to the right', 'down-right'],
  [67.5, 'straight down', 'down'],
  [112.5, 'sweeping down-left', 'down-left'],
  [157.5, 'right to left', 'left'],
  [-157.5, 'up to the left', 'up-left'],
  [-112.5, 'straight up', 'up'],
  [-67.5, 'rising to the right', 'up-right'],
] as const;

function heading(from: Point, to: Point, short = false): string {
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  const inSector = (lo: number) => {
    const rel = (((angle - lo) % 360) + 360) % 360;
    return rel < 45;
  };
  const h = HEADINGS.find(([lo]) => inSector(lo)) ?? HEADINGS[0];
  return short ? h[2] : h[1];
}

/** The point farthest from the start–end chord, if the stroke bends sharply there. */
function corner(points: readonly Point[]): { at: Point; fraction: number } | undefined {
  const total = polylineLength(points);
  if (total < SHORT_STROKE || points.length < 3) return undefined;
  const first = points[0];
  const last = points[points.length - 1];
  const cx = last.x - first.x;
  const cy = last.y - first.y;
  const chord = Math.hypot(cx, cy) || 1;
  let far = 0;
  let best = { at: first, fraction: 0 };
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    walked += distance(points[i - 1], points[i]);
    const d = Math.abs((points[i].x - first.x) * cy - (points[i].y - first.y) * cx) / chord;
    if (d > far) {
      far = d;
      best = { at: points[i], fraction: walked / total };
    }
  }
  return far >= total * BEND_FRACTION ? best : undefined;
}

/** A bend counts when it lies this far (fraction of the stroke's length) off the chord. */
const BEND_FRACTION = 0.18;
/** A bend this close to the end is a hook rather than a change of direction. */
const HOOK_FRACTION = 0.8;

/** "a short stroke, top right, sweeping down-left" */
export function describeStroke(d: string): string {
  const pts = flattenPath(d);
  if (pts.length < 2) return 'a dot';
  const len = pathLength(d);
  const size = len < SHORT_STROKE ? 'a short stroke' : len > LONG_STROKE ? 'a long stroke' : 'a stroke';
  const start = pts[0];
  const end = pts[pts.length - 1];
  const bend = corner(pts);
  const where = `${size}, ${region(start)}`;
  if (!bend) return `${where}, ${heading(start, end)}`;
  if (bend.fraction > HOOK_FRACTION) return `${where}, ${heading(start, bend.at)}, with a hook at the end`;
  return `${where}, ${heading(start, bend.at)}, then ${heading(bend.at, end, true)}`;
}

/**
 * One short sentence explaining why a stroke was not accepted. `hintShown`
 * when the pad is showing this stroke as a hint (Hint, or after repeated
 * misses), so the advice can point at it.
 */
export function mistakeMessage(attempt: StrokeAttempt, index: number, hintShown = false): string {
  if (attempt.drewStroke !== undefined) {
    return attempt.drewStroke > index
      ? `That looks like stroke ${attempt.drewStroke + 1}. Stroke ${index + 1} comes first.`
      : `That looks like stroke ${attempt.drewStroke + 1} again. Try stroke ${index + 1}.`;
  }
  switch (attempt.reason) {
    case 'too-short':
      return 'Keep going: that stroke is longer.';
    case 'direction':
      return 'Check the direction this stroke travels.';
    case 'position':
      return 'Close. Check where this stroke starts and ends.';
    case 'shape':
      return hintShown ? 'The shape is off. Watch the hint and try again.' : 'The shape is off. Try that stroke again.';
    default:
      return 'Not quite. Try that stroke again.';
  }
}

/** At most this many stroke-order notes after a recall attempt: more would bury the useful one. */
export const MAX_ORDER_NOTES = 2;

export interface OrderNote {
  text: string;
  /** The two model strokes the note is about (0-based): `first` usually comes before `then`. */
  first: number;
  then: number;
}

/**
 * Coaching for strokes written out of order ("Stroke 1 usually comes before stroke 4."), from a whole-character
 * recall match. Order never affects the grade; these notes only teach it.
 */
export function orderNotes(match: Pick<UnorderedMatch, 'orderSlips' | 'assignment' | 'unmatched'>): OrderNote[] {
  const drawnAt = new Map<number, number>();
  match.assignment.forEach((j, i) => {
    if (j !== null && !match.unmatched.includes(i)) drawnAt.set(i, j);
  });
  const notes: OrderNote[] = [];
  const seen = new Set<string>();
  for (const slip of match.orderSlips) {
    const e = slip.expected;
    // An earlier stroke drawn after this one, else a later stroke drawn before it.
    const earlier = [...drawnAt].filter(([f, d]) => f < e && d > slip.drawnAt).map(([f]) => f);
    const later = [...drawnAt].filter(([f, d]) => f > e && d < slip.drawnAt).map(([f]) => f);
    const pair = earlier.length ? { first: Math.min(...earlier), then: e } : later.length ? { first: e, then: Math.min(...later) } : null;
    if (!pair) continue;
    const key = `${pair.first}-${pair.then}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ ...pair, text: `Stroke ${pair.first + 1} usually comes before stroke ${pair.then + 1}.` });
    if (notes.length >= MAX_ORDER_NOTES) break;
  }
  return notes;
}
