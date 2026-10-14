// Dependency-free SVG path tools for KanjiVG stroke data (109×109 box).
// Parses `d` strings, flattens them to polylines and resamples by arc length.
// Pure functions with no DOM access, so they run in Node, workers and tests.

export interface Point {
  x: number;
  y: number;
}

/** Side of KanjiVG's square viewBox. */
export const BOX = 109;
export const BOX_CENTER: Point = { x: BOX / 2, y: BOX / 2 };

export type Segment =
  | { kind: 'line'; from: Point; to: Point }
  | { kind: 'quad'; from: Point; c: Point; to: Point }
  | { kind: 'cubic'; from: Point; c1: Point; c2: Point; to: Point };

export class PathParseError extends Error {
  readonly d: string;

  constructor(message: string, d: string) {
    super(`${message} in path "${d.length > 60 ? `${d.slice(0, 60)}…` : d}"`);
    this.name = 'PathParseError';
    this.d = d;
  }
}

const TOKEN = /([MmLlHhVvCcSsQqTtZzAa])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;

/** Numbers each command consumes per repetition. */
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, z: 0 };

type Token = string | number;

function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  for (const m of d.matchAll(TOKEN)) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
    else if (m[4]) throw new PathParseError(`Unexpected character '${m[4]}'`, d);
  }
  return tokens;
}

/**
 * Parses an SVG path into absolute line / quadratic / cubic segments.
 * Supports M L H V C S Q T Z in both cases, implicit repeated commands
 * (extra pairs after M are line-tos) and compact numbers such as
 * `-1.66-3.03` or `.5.5`. Elliptical arcs never occur in KanjiVG and are rejected.
 */
export function parsePath(d: string): Segment[] {
  const tokens = tokenize(d);
  const segments: Segment[] = [];
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  // Reflection sources for S and T: the previous segment's last control point.
  let lastCubicCtrl: Point | undefined;
  let lastQuadCtrl: Point | undefined;
  let i = 0;
  let cmd = '';

  const num = (): number => {
    const t = tokens[i++];
    if (typeof t !== 'number') throw new PathParseError(`Expected a number after '${cmd}'`, d);
    return t;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'A' || cmd === 'a') throw new PathParseError('Arc commands are not supported', d);
    } else if (!cmd) {
      throw new PathParseError('Path must start with a command', d);
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    } else if (cmd === 'Z' || cmd === 'z') {
      throw new PathParseError("Unexpected number after 'Z'", d);
    }

    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    const ox = rel ? cur.x : 0;
    const oy = rel ? cur.y : 0;
    const pt = (): Point => ({ x: ox + num(), y: oy + num() });
    if (ARITY[lower] > 0 && typeof tokens[i] !== 'number') {
      throw new PathParseError(`Missing coordinates for '${cmd}'`, d);
    }

    switch (lower) {
      case 'm': {
        cur = pt();
        start = cur;
        lastCubicCtrl = lastQuadCtrl = undefined;
        break;
      }
      case 'l': {
        const to = pt();
        segments.push({ kind: 'line', from: cur, to });
        cur = to;
        lastCubicCtrl = lastQuadCtrl = undefined;
        break;
      }
      case 'h': {
        const to = { x: ox + num(), y: cur.y };
        segments.push({ kind: 'line', from: cur, to });
        cur = to;
        lastCubicCtrl = lastQuadCtrl = undefined;
        break;
      }
      case 'v': {
        const to = { x: cur.x, y: oy + num() };
        segments.push({ kind: 'line', from: cur, to });
        cur = to;
        lastCubicCtrl = lastQuadCtrl = undefined;
        break;
      }
      case 'c': {
        const c1 = pt();
        const c2 = pt();
        const to = pt();
        segments.push({ kind: 'cubic', from: cur, c1, c2, to });
        cur = to;
        lastCubicCtrl = c2;
        lastQuadCtrl = undefined;
        break;
      }
      case 's': {
        const c1 = lastCubicCtrl ? reflect(lastCubicCtrl, cur) : cur;
        const c2 = pt();
        const to = pt();
        segments.push({ kind: 'cubic', from: cur, c1, c2, to });
        cur = to;
        lastCubicCtrl = c2;
        lastQuadCtrl = undefined;
        break;
      }
      case 'q': {
        const c = pt();
        const to = pt();
        segments.push({ kind: 'quad', from: cur, c, to });
        cur = to;
        lastQuadCtrl = c;
        lastCubicCtrl = undefined;
        break;
      }
      case 't': {
        const c = lastQuadCtrl ? reflect(lastQuadCtrl, cur) : cur;
        const to = pt();
        segments.push({ kind: 'quad', from: cur, c, to });
        cur = to;
        lastQuadCtrl = c;
        lastCubicCtrl = undefined;
        break;
      }
      case 'z': {
        if (cur.x !== start.x || cur.y !== start.y) segments.push({ kind: 'line', from: cur, to: start });
        cur = start;
        lastCubicCtrl = lastQuadCtrl = undefined;
        break;
      }
      default:
        throw new PathParseError(`Unknown command '${cmd}'`, d);
    }
  }
  return segments;
}

function reflect(p: Point, about: Point): Point {
  return { x: 2 * about.x - p.x, y: 2 * about.y - p.y };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polylineLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1], points[i]);
  return len;
}

/** Curves are split so each chord is at most this long (box units): error ≪ 0.05 units. */
const FLATTEN_STEP = 1.5;
const MAX_CURVE_PIECES = 64;

function flattenSegments(segments: readonly Segment[]): Point[] {
  if (segments.length === 0) return [];
  const out: Point[] = [segments[0].from];
  for (const s of segments) {
    if (s.kind === 'line') {
      out.push(s.to);
      continue;
    }
    const hull = s.kind === 'quad'
      ? distance(s.from, s.c) + distance(s.c, s.to)
      : distance(s.from, s.c1) + distance(s.c1, s.c2) + distance(s.c2, s.to);
    const pieces = Math.min(MAX_CURVE_PIECES, Math.max(2, Math.ceil(hull / FLATTEN_STEP)));
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      const u = 1 - t;
      if (s.kind === 'quad') {
        out.push({
          x: u * u * s.from.x + 2 * u * t * s.c.x + t * t * s.to.x,
          y: u * u * s.from.y + 2 * u * t * s.c.y + t * t * s.to.y,
        });
      } else {
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const e = t * t * t;
        out.push({
          x: a * s.from.x + b * s.c1.x + c * s.c2.x + e * s.to.x,
          y: a * s.from.y + b * s.c1.y + c * s.c2.y + e * s.to.y,
        });
      }
    }
  }
  return out;
}

// KanjiVG strokes are re-sampled on every pen-up and in every animation frame,
// so flattened paths are memoized. The cap keeps memory bounded on long sessions.
const FLATTEN_CACHE_LIMIT = 1024;
const flattenCache = new Map<string, readonly Point[]>();

/** The path as a dense polyline (shared, do not mutate). */
export function flattenPath(d: string): readonly Point[] {
  let pts = flattenCache.get(d);
  if (!pts) {
    pts = flattenSegments(parsePath(d));
    if (flattenCache.size >= FLATTEN_CACHE_LIMIT) {
      flattenCache.delete(flattenCache.keys().next().value as string);
    }
    flattenCache.set(d, pts);
  }
  return pts;
}

export function pathLength(d: string): number {
  return polylineLength(flattenPath(d));
}

/**
 * Resamples a polyline to `n` points evenly spaced by arc length. The first and
 * last points are kept exactly. A degenerate (zero-length) input yields `n`
 * copies of its first point.
 */
export function resample(points: readonly Point[], n: number): Point[] {
  if (points.length === 0) return [];
  if (n <= 1) return [{ ...points[0] }];
  const total = polylineLength(points);
  if (total === 0) return Array.from({ length: n }, () => ({ ...points[0] }));

  const step = total / (n - 1);
  const out: Point[] = [{ ...points[0] }];
  let seg = 1;
  let segStart = 0; // arc length at points[seg - 1]
  let segLen = distance(points[0], points[1]);
  for (let k = 1; k < n - 1; k++) {
    const target = k * step;
    while (segStart + segLen < target && seg < points.length - 1) {
      segStart += segLen;
      seg++;
      segLen = distance(points[seg - 1], points[seg]);
    }
    const a = points[seg - 1];
    const b = points[seg];
    const t = segLen > 0 ? (target - segStart) / segLen : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  out.push({ ...points[points.length - 1] });
  return out;
}

/** `n` points evenly spaced along the path by arc length. */
export function samplePath(d: string, n: number): Point[] {
  return resample(flattenPath(d), n);
}

export function pathStart(d: string): Point {
  const pts = flattenPath(d);
  return pts.length ? { ...pts[0] } : { ...BOX_CENTER };
}

/**
 * Unit vector of the stroke's initial heading, measured over its first
 * `lookahead` units so KanjiVG's tiny entry serifs don't skew it.
 */
export function startDirection(d: string, lookahead = 12): Point {
  const pts = flattenPath(d);
  if (pts.length < 2) return { x: 0, y: 1 };
  const total = polylineLength(pts);
  const reach = Math.min(lookahead, total);
  let walked = 0;
  let end = pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    walked += distance(pts[i - 1], pts[i]);
    if (walked >= reach) {
      end = pts[i];
      break;
    }
  }
  const dx = end.x - pts[0].x;
  const dy = end.y - pts[0].y;
  const len = Math.hypot(dx, dy);
  return len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: 1 };
}

/**
 * Brush width (box units) for drawing a character: `base` for simple
 * characters, thinner as strokes crowd together so busy kanji stay legible.
 */
export function inkWidth(strokeCount: number, base = 6): number {
  const crowded = Math.max(0, strokeCount - 6);
  return Math.max(base * 0.6, base - crowded * base * 0.05);
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

/** Polyline as a compact `d` string. */
export function polylineToPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i].x)} ${fmt(points[i].y)}`;
  return d;
}

/**
 * Smooth `d` string through the points for drawing live ink: quadratic curves
 * through the midpoints, so finger jitter reads as a brush line, not a zig-zag.
 */
export function smoothPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  if (points.length < 3) {
    // A lone point still needs a visible dot under round caps.
    const p = points[0];
    const q = points[points.length - 1];
    return `M${fmt(p.x)} ${fmt(p.y)}L${fmt(q.x + (p === q ? 0.01 : 0))} ${fmt(q.y)}`;
  }
  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const n = points[i + 1];
    d += `Q${fmt(p.x)} ${fmt(p.y)} ${fmt((p.x + n.x) / 2)} ${fmt((p.y + n.y) / 2)}`;
  }
  const last = points[points.length - 1];
  return `${d}L${fmt(last.x)} ${fmt(last.y)}`;
}
