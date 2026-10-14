// Synthetic handwriting for tests and threshold tuning: turns clean KanjiVG
// strokes into the kind of input a finger on a phone produces. Deterministic
// for a given seed. Not used by the app at runtime.

import { BOX, BOX_CENTER, distance, flattenPath, polylineLength, resample, type Point } from './path.ts';

export type Rng = () => number;

/** Small, fast seeded PRNG (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const uniform = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** How the whole character is placed relative to the model: uniform scale about the box centre, then an offset. */
export interface Placement {
  scale: number;
  dx: number;
  dy: number;
}

export interface PlacementRange {
  scale: [number, number];
  offset: number;
}

export const DEFAULT_PLACEMENT: PlacementRange = { scale: [0.8, 1.2], offset: 8 };

export function randomPlacement(rng: Rng, range: PlacementRange = DEFAULT_PLACEMENT): Placement {
  return {
    scale: uniform(rng, range.scale[0], range.scale[1]),
    dx: uniform(rng, -range.offset, range.offset),
    dy: uniform(rng, -range.offset, range.offset),
  };
}

export function place(p: Point, t: Placement): Point {
  return {
    x: BOX_CENTER.x + (p.x - BOX_CENTER.x) * t.scale + t.dx,
    y: BOX_CENTER.y + (p.y - BOX_CENTER.y) * t.scale + t.dy,
  };
}

export interface HandOptions {
  /** Standard deviation of the wobble, box units, drawn uniformly from this range. */
  jitter: [number, number];
  /** Distance between independent wobble knots along the stroke (spatial correlation). */
  wobbleSpacing: [number, number];
  /** Pen travel per input event, box units (speed × event interval). */
  step: [number, number];
  /** Probability range for dropping each interior input point. */
  drop: [number, number];
  /** Per-point digitizer noise (σ, box units). */
  sensorNoise: number;
  /** The finger may land late or lift early by up to this much (box units). */
  endTrim: number;
  /** Or overshoot the end by up to this much. */
  overshoot: number;
}

export const FINGER: HandOptions = {
  jitter: [3, 6],
  wobbleSpacing: [12, 24],
  step: [1.5, 7],
  drop: [0, 0.35],
  sensorNoise: 0.5,
  endTrim: 3,
  overshoot: 3,
};

/** Strokes shorter than this wobble mostly as a whole (misplaced) rather than bending. */
const BEND_LENGTH = 40;

/**
 * Smooth random displacement along a polyline: gaussian knots with smoothstep
 * interpolation. Every point is displaced by ~σ, but on short strokes most of
 * that is shared by all knots: a hand misplaces a short flick, it cannot
 * meander within 5 mm.
 */
function wobble(points: readonly Point[], rng: Rng, sigma: number, spacing: number): Point[] {
  const total = polylineLength(points);
  const knots = Math.ceil(total / spacing) + 2;
  const local = sigma * Math.min(1, total / BEND_LENGTH);
  const shared = Math.sqrt(sigma * sigma - local * local);
  const sx = gaussian(rng) * shared;
  const sy = gaussian(rng) * shared;
  const kx = Array.from({ length: knots }, () => sx + gaussian(rng) * local);
  const ky = Array.from({ length: knots }, () => sy + gaussian(rng) * local);
  let s = 0;
  return points.map((p, i) => {
    if (i > 0) s += distance(points[i - 1], p);
    const u = s / spacing;
    const k = Math.floor(u);
    const f = u - k;
    const w = f * f * (3 - 2 * f);
    return { x: p.x + kx[k] * (1 - w) + kx[k + 1] * w, y: p.y + ky[k] * (1 - w) + ky[k + 1] * w };
  });
}

/** Point at arc length `s` along a polyline with precomputed cumulative lengths. */
function at(points: readonly Point[], cum: readonly number[], s: number): Point {
  if (s <= 0) return points[0];
  const last = points.length - 1;
  if (s >= cum[last]) {
    // Extrapolate along the final heading (overshoot).
    const a = points[last - 1];
    const b = points[last];
    const seg = distance(a, b) || 1;
    const over = s - cum[last];
    return { x: b.x + ((b.x - a.x) / seg) * over, y: b.y + ((b.y - a.y) / seg) * over };
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return { x: points[lo].x + (points[hi].x - points[lo].x) * t, y: points[lo].y + (points[hi].y - points[lo].y) * t };
}

/**
 * Turns a clean polyline into pointer samples: the pen accelerates and slows
 * along the stroke (bell-shaped speed with random variation), the device drops
 * events, and the digitizer adds noise.
 */
export function penSamples(path: readonly Point[], rng: Rng, hand: HandOptions = FINGER): Point[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distance(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  const startS = uniform(rng, 0, Math.min(hand.endTrim, total * 0.15));
  const endS = total + uniform(rng, -Math.min(hand.endTrim, total * 0.15), hand.overshoot);
  const peak = uniform(rng, hand.step[0], hand.step[1]);
  const dropP = uniform(rng, hand.drop[0], hand.drop[1]);

  const raw: Point[] = [];
  for (let s = startS; s < endS; ) {
    raw.push(at(path, cum, s));
    const phase = (s - startS) / Math.max(endS - startS, 1e-6);
    const bell = Math.max(0.25, Math.sin(Math.PI * Math.min(1, Math.max(0, phase))) ** 0.6);
    s += Math.max(0.2, peak * bell * (1 + 0.3 * gaussian(rng)));
  }
  raw.push(at(path, cum, endS));

  const kept = raw.filter((_, i) => i === 0 || i === raw.length - 1 || rng() >= dropP);
  return kept.map((p) => ({
    x: p.x + gaussian(rng) * hand.sensorNoise,
    y: p.y + gaussian(rng) * hand.sensorNoise,
  }));
}

/** A plausible finger rendition of a KanjiVG stroke, placed with `placement`. */
export function synthStroke(d: string, placement: Placement, rng: Rng, hand: HandOptions = FINGER): Point[] {
  const clean = flattenPath(d);
  const dense = resample(clean, Math.max(8, Math.ceil(polylineLength(clean)) + 1));
  const sigma = uniform(rng, hand.jitter[0], hand.jitter[1]);
  const spacing = uniform(rng, hand.wobbleSpacing[0], hand.wobbleSpacing[1]);
  const wobbly = wobble(dense, rng, sigma, spacing).map((p) => place(p, placement));
  return penSamples(wobbly, rng, hand);
}

/** A random squiggle: a few joined, curved segments with sharp-ish turns, inside the box. */
export function scribble(rng: Rng, hand: HandOptions = FINGER): Point[] {
  const segments = 2 + Math.floor(rng() * 5);
  let p: Point = { x: uniform(rng, 15, BOX - 15), y: uniform(rng, 15, BOX - 15) };
  let heading = uniform(rng, 0, 2 * Math.PI);
  const pts: Point[] = [p];
  for (let s = 0; s < segments; s++) {
    const len = uniform(rng, 12, 35);
    const bend = uniform(rng, -0.08, 0.08);
    for (let t = 0; t < len; t += 1) {
      heading += bend;
      p = {
        x: Math.min(BOX - 2, Math.max(2, p.x + Math.cos(heading))),
        y: Math.min(BOX - 2, Math.max(2, p.y + Math.sin(heading))),
      };
      pts.push(p);
    }
    heading += (rng() < 0.5 ? -1 : 1) * uniform(rng, Math.PI / 6, (5 * Math.PI) / 6);
  }
  return penSamples(pts, rng, hand);
}
