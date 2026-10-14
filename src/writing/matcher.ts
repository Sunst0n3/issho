// Stroke matcher: decides whether a hand-drawn stroke is the expected KanjiVG
// stroke. Everything is measured in KanjiVG's 109×109 box.
//
// It has to forgive a wobbly finger on a phone (strokes a few units off,
// a bit bigger or smaller, drawn fast with few points) while still catching
// the mistakes that matter for learning: wrong direction, wrong stroke
// (order), and wrong shape. Accepted strokes build a frame (where and how big
// the learner is writing) so later strokes are judged more tightly, and
// matchStrokeOf compares a drawing with the character's other strokes to
// catch order slips in dense kanji. The thresholds below were tuned against synthetic
// finger strokes in matcher.test.ts; change them only together with that test.

import { BOX_CENTER, distance, polylineLength, resample, samplePath, type Point } from './path.ts';

export type MismatchReason = 'too-short' | 'direction' | 'position' | 'shape';

export interface StrokeMatch {
  ok: boolean;
  /** 0..1; ≥ 0.5 exactly when `ok`. 1 is a perfect copy of the model stroke. */
  score: number;
  reason?: MismatchReason;
}

/**
 * Where the learner is drawing the character relative to the model:
 * `user = model * scale + (dx, dy)`. Estimated from strokes already accepted,
 * so a character drawn small or off-centre is judged on its own terms.
 */
export interface Frame {
  scale: number;
  dx: number;
  dy: number;
  /** 0..1: how much evidence backs this frame. Position limits tighten as it grows. */
  confidence: number;
}

export const IDENTITY_FRAME: Frame = { scale: 1, dx: 0, dy: 0, confidence: 0 };

/**
 * Leniency for Settings → I write with: Stylus. A pen wobbles far less than a finger, so the
 * matcher can be stricter. Checked against matcher.test.ts: synthetic stylus strokes are all
 * still accepted (finger strokes too, at ~99.7%), and fewer wrong strokes pass.
 */
export const STYLUS_LENIENCY = 0.85;

export interface MatchOptions {
  /** Placement estimated from earlier strokes (see `estimateFrame`). */
  frame?: Frame;
  /** Multiplies the position, shape and length tolerances: > 1 is more forgiving, < 1 stricter (a stylus). */
  leniency?: number;
}

/** Both strokes are resampled to this many points before comparing. */
export const SAMPLE_POINTS = 32;

// --- Input clean-up -------------------------------------------------------
/** Input points closer than this to the previous kept point are dropped (digitizer noise). */
export const MIN_POINT_SPACING = 1.2;
/** Passes of [¼ ½ ¼] smoothing applied to the user's stroke. */
export const SMOOTHING_PASSES = 2;

// --- Length ---------------------------------------------------------------
/** User length / model length below this is 'too-short'. */
export const MIN_LENGTH_RATIO = 0.4;
/**
 * Model strokes up to this long (box units) are dots and short ticks (、): on a
 * phone they are often just dabbed or tapped, so any length passes (see also
 * MIN_USER_CHORD). KanjiVG's ㇔ dots are 9–24 units, median 14.
 */
export const DOT_LENGTH = 20;
/** Between DOT_LENGTH and this length the minimum length ratio ramps up to MIN_LENGTH_RATIO. */
export const FULL_LENGTH_CHECK = 36;
/** User length / model length above this is 'shape' (scribbles, doubled-back strokes). */
export const MAX_LENGTH_RATIO = 2.1;
/** For the too-long check, model strokes count as at least this long: nobody draws a 4-unit tick to scale. */
export const SHORT_STROKE_FLOOR = 10;

// --- Position (box units). The first stroke has no frame yet and must allow
// for the whole character being drawn shifted or scaled; later strokes are
// compared after removing the estimated frame, so they get tighter limits. ---
export const START_TOLERANCE = 32;
export const END_TOLERANCE = 34;
export const MEAN_TOLERANCE = 22;
/** Multiplier on position tolerances once a fully trusted frame is known (scaled by its confidence). */
export const FRAMED_POSITION_FACTOR = 0.8;
/**
 * On a phone, learners often write the whole character smaller than the box,
 * which pulls every stroke toward the centre and onto its inner neighbours.
 * The first stroke has no frame to measure their size, so its mean position
 * and its rivals are compared after scaling each model stroke about the box
 * centre by up to this much.
 */
export const LOOSE_SCALE_RANGE: [number, number] = [0.7, 1.1];

// --- Shape: centred mean distance, so placement does not count. ------------
/** Absolute part of the shape tolerance (dominates for short strokes and dots). */
export const SHAPE_TOLERANCE = 6.5;
/** Plus this fraction of the model stroke's length. */
export const SHAPE_TOLERANCE_PER_LENGTH = 0.1;

/** Mean heading difference (radians) along the stroke, compared over windows of TURN_WINDOW samples. */
export const TURN_TOLERANCE = 0.7;
export const TURN_WINDOW = 8;
/** Model strokes shorter than this skip the heading check: a finger can't steer a short flick or a small loop. */
export const TURN_MIN_LENGTH = 50;

// --- Direction --------------------------------------------------------------
/** Reversed if matching the model backwards is this much closer than forwards. */
export const REVERSED_RATIO = 0.6;
/** …and the forward match is at least this far off (tiny strokes have no direction to speak of). */
export const REVERSED_MIN_DISTANCE = 6;
/** Minimum cosine between the user's and the model's start→end vectors. */
export const MIN_CHORD_COSINE = 0.45;
/** The chord check applies only when the model's chord is at least this fraction of its length (not loops). */
export const CHORD_MIN_FRACTION = 0.3;
/** …and the drawing's chord is at least this long: a dab has no direction to speak of. */
export const MIN_USER_CHORD = 4;

// --- Frame estimation -------------------------------------------------------
export const FRAME_SCALE_RANGE: [number, number] = [0.6, 1.5];
/** Variance (box units²) of model points that counts as half the evidence needed to trust a scale. */
export const FRAME_SPREAD_PRIOR = 150;
/** Number of strokes that counts as half the evidence needed to trust an offset. */
export const FRAME_STROKE_PRIOR = 1.5;

// --- Rival strokes (matchStrokeOf) -----------------------------------------
/** Reject when another stroke of the character is this much closer than the expected one… */
export const RIVAL_RATIO = 0.6;
/** …unless the drawing is already this close to the expected stroke (box units). */
export const RIVAL_MIN_DISTANCE = 4;
/**
 * Strokes whose model paths are closer than this (mean distance, box units) are
 * twins, like the two ticks of a dakuten: either is accepted for the other.
 */
export const RIVAL_MIN_SEPARATION = 9.5;

/** Raw measurements behind a match (useful for tuning and debugging). */
export interface StrokeFeatures {
  userLength: number;
  targetLength: number;
  startDistance: number;
  endDistance: number;
  meanDistance: number;
  reversedMeanDistance: number;
  shapeDistance: number;
  /** Mean difference in heading (radians) between matching stretches of the two strokes. */
  turnDistance: number;
  /** NaN when the model stroke is loop-like or the drawing is a dab: no meaningful chord. */
  chordCosine: number;
  /**
   * `meanDistance` allowing for the unknown size of the learner's writing:
   * with no frame yet, the model stroke may be scaled about the box centre
   * (see LOOSE_SCALE_RANGE); with a frame, equal to `meanDistance`.
   */
  placedDistance: number;
}

function toModel(p: Point, f: Frame): Point {
  return { x: (p.x - f.dx) / f.scale, y: (p.y - f.dy) / f.scale };
}

/** Drops near-duplicate points, then smooths: removes digitizer noise without moving the ends. */
export function cleanStroke(points: readonly Point[]): Point[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const kept: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (distance(points[i], kept[kept.length - 1]) >= MIN_POINT_SPACING) kept.push(points[i]);
  }
  const last = points[points.length - 1];
  if (kept.length > 1 && distance(last, kept[kept.length - 1]) < MIN_POINT_SPACING) kept.pop();
  kept.push(last);

  let pts = kept;
  for (let pass = 0; pass < SMOOTHING_PASSES && pts.length > 2; pass++) {
    pts = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      const a = pts[i - 1];
      const b = pts[i + 1];
      return { x: 0.25 * a.x + 0.5 * p.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * p.y + 0.25 * b.y };
    });
  }
  return pts;
}

function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** The user's stroke cleaned, mapped into model space and resampled: ready to compare against any target. */
export function prepareStroke(userPoints: readonly Point[], frame: Frame = IDENTITY_FRAME): Point[] {
  return resample(cleanStroke(userPoints.map((p) => toModel(p, frame))), SAMPLE_POINTS);
}

/**
 * Mean distance between `u` and the model stroke `t` scaled about the box
 * centre by the least-squares factor, clamped to LOOSE_SCALE_RANGE.
 */
function scaledMeanDistance(u: readonly Point[], t: readonly Point[]): number {
  const [lo, hi] = LOOSE_SCALE_RANGE;
  const c = BOX_CENTER;
  let num = 0;
  let den = 0;
  for (let i = 0; i < u.length; i++) {
    num += (u[i].x - c.x) * (t[i].x - c.x) + (u[i].y - c.y) * (t[i].y - c.y);
    den += (t[i].x - c.x) ** 2 + (t[i].y - c.y) ** 2;
  }
  const s = den > 0 ? Math.min(hi, Math.max(lo, num / den)) : 1;
  let sum = 0;
  for (let i = 0; i < u.length; i++) {
    sum += Math.hypot(u[i].x - (c.x + (t[i].x - c.x) * s), u[i].y - (c.y + (t[i].y - c.y) * s));
  }
  return sum / u.length;
}

function featuresOf(u: readonly Point[], targetD: string, confidence: number): StrokeFeatures {
  const t = samplePath(targetD, SAMPLE_POINTS);
  const n = SAMPLE_POINTS;

  let mean = 0;
  let reversed = 0;
  let shape = 0;
  const uc = centroid(u);
  const tc = centroid(t);
  for (let i = 0; i < n; i++) {
    mean += distance(u[i], t[i]);
    reversed += distance(u[i], t[n - 1 - i]);
    shape += Math.hypot(u[i].x - uc.x - (t[i].x - tc.x), u[i].y - uc.y - (t[i].y - tc.y));
  }

  let turn = 0;
  let windows = 0;
  for (let i = 0; i + TURN_WINDOW < n; i += 2) {
    const ua = Math.atan2(u[i + TURN_WINDOW].y - u[i].y, u[i + TURN_WINDOW].x - u[i].x);
    const ta = Math.atan2(t[i + TURN_WINDOW].y - t[i].y, t[i + TURN_WINDOW].x - t[i].x);
    const diff = Math.abs(ua - ta);
    turn += diff > Math.PI ? 2 * Math.PI - diff : diff;
    windows++;
  }

  const targetLength = polylineLength(t);
  const tx = t[n - 1].x - t[0].x;
  const ty = t[n - 1].y - t[0].y;
  const tChord = Math.hypot(tx, ty);
  const ux = u[n - 1].x - u[0].x;
  const uy = u[n - 1].y - u[0].y;
  const uChord = Math.hypot(ux, uy);
  const chordCosine = tChord > 0 && tChord >= CHORD_MIN_FRACTION * targetLength && uChord >= MIN_USER_CHORD
    ? (ux * tx + uy * ty) / (uChord * tChord)
    : Number.NaN;

  return {
    userLength: polylineLength(u),
    targetLength,
    startDistance: distance(u[0], t[0]),
    endDistance: distance(u[n - 1], t[n - 1]),
    meanDistance: mean / n,
    reversedMeanDistance: reversed / n,
    shapeDistance: shape / n,
    turnDistance: windows ? turn / windows : 0,
    chordCosine,
    // Once any stroke has been accepted, the frame carries the learner's size.
    placedDistance: confidence > 0 ? mean / n : Math.min(mean / n, scaledMeanDistance(u, t)),
  };
}

export function strokeFeatures(userPoints: readonly Point[], targetD: string, frame: Frame = IDENTITY_FRAME): StrokeFeatures {
  return featuresOf(prepareStroke(userPoints, frame), targetD, frame.confidence);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Score from the worst "badness" ratio, where 1 is the limit of acceptable. */
const scoreFor = (worst: number) => clamp01(1 - worst / 2);

/** User length / model length below which a stroke of this length is 'too-short' (0 for dots). */
function minLengthRatio(targetLength: number, leniency: number): number {
  const ramp = clamp01((targetLength - DOT_LENGTH) / (FULL_LENGTH_CHECK - DOT_LENGTH));
  return (MIN_LENGTH_RATIO * ramp) / leniency;
}

function judge(f: StrokeFeatures, frame: Frame, leniency: number): StrokeMatch {
  // Each "bad" value is 0 for a perfect copy and 1 at the limit of acceptable.
  const lengthRatio = f.userLength / Math.max(f.targetLength, 1e-6);
  const shortBad = lengthRatio >= 1 ? 0 : (1 - lengthRatio) / (1 - minLengthRatio(f.targetLength, leniency));
  const longRatio = f.userLength / Math.max(f.targetLength, SHORT_STROKE_FLOOR);
  const longBad = longRatio <= 1 ? 0 : (longRatio - 1) / (MAX_LENGTH_RATIO * leniency - 1);
  // Direction is not scaled by leniency: a backwards stroke is never "nearly right".
  const reversedBad = f.meanDistance > REVERSED_MIN_DISTANCE
    ? (REVERSED_RATIO * f.meanDistance) / Math.max(f.reversedMeanDistance, 1e-6)
    : 0;
  const chordBad = Number.isNaN(f.chordCosine) ? 0 : (1 - f.chordCosine) / (1 - MIN_CHORD_COSINE);
  const directionBad = Math.max(reversedBad, chordBad);

  const posFactor = leniency * (1 - (1 - FRAMED_POSITION_FACTOR) * frame.confidence);
  const startBad = f.startDistance / (START_TOLERANCE * posFactor);
  const positionBad = Math.max(
    startBad,
    f.endDistance / (END_TOLERANCE * posFactor),
    // Start and end stay absolute: a stub of a stroke must not pass as the whole stroke written small.
    f.placedDistance / (MEAN_TOLERANCE * posFactor),
  );
  const shapeBad = Math.max(
    f.shapeDistance / ((SHAPE_TOLERANCE + SHAPE_TOLERANCE_PER_LENGTH * f.targetLength) * leniency),
    f.targetLength >= TURN_MIN_LENGTH ? f.turnDistance / (TURN_TOLERANCE * leniency) : 0,
    longBad,
  );

  const worst = Math.max(shortBad, directionBad, positionBad, shapeBad);
  const score = scoreFor(worst);
  if (worst <= 1) return { ok: true, score };
  // Name the most useful mistake: a stub where the stroke should start is
  // "too short"; a stroke drawn backwards is "direction" even though its ends
  // are also misplaced; otherwise whichever check failed worst.
  if (shortBad > 1 && startBad <= 1) return { ok: false, score, reason: 'too-short' };
  if (reversedBad > 1) return { ok: false, score, reason: 'direction' };
  const ranked: Array<[MismatchReason, number]> = [
    ['direction', directionBad],
    ['position', positionBad],
    ['shape', shapeBad],
    ['too-short', shortBad],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return { ok: false, score, reason: ranked[0][0] };
}

/**
 * Checks one drawn stroke (points in the 109 box) against the expected
 * KanjiVG stroke: long enough, right direction, start/end/mean position
 * and centred shape.
 */
export function matchStroke(userPoints: readonly Point[], targetD: string, opts: MatchOptions = {}): StrokeMatch {
  if (userPoints.length === 0) return { ok: false, score: 0, reason: 'too-short' };
  const frame = opts.frame ?? IDENTITY_FRAME;
  return judge(strokeFeatures(userPoints, targetD, frame), frame, opts.leniency ?? 1);
}

/** Mean distance between two model strokes, point for point. */
function separation(a: string, b: string): number {
  const pa = samplePath(a, SAMPLE_POINTS);
  const pb = samplePath(b, SAMPLE_POINTS);
  let sum = 0;
  for (let i = 0; i < SAMPLE_POINTS; i++) sum += distance(pa[i], pb[i]);
  return sum / SAMPLE_POINTS;
}

export interface StrokeAttempt extends StrokeMatch {
  /** The drawing is (clearly closer to) this other stroke of the character. */
  drewStroke?: number;
}

/**
 * Checks a drawn stroke as stroke `index` of a character. On top of
 * `matchStroke`, it compares the drawing with the character's other strokes:
 * in dense kanji neighbouring strokes are only ~10 units apart, well inside the
 * finger-friendly tolerances, so a drawing that sits clearly closer to another
 * stroke is rejected as that stroke (a stroke-order slip).
 */
export function matchStrokeOf(
  userPoints: readonly Point[],
  strokes: readonly string[],
  index: number,
  opts: MatchOptions = {},
): StrokeAttempt {
  const target = strokes[index];
  if (target === undefined) throw new RangeError(`No stroke ${index} in a ${strokes.length}-stroke character`);
  if (userPoints.length === 0) return { ok: false, score: 0, reason: 'too-short' };

  const frame = opts.frame ?? IDENTITY_FRAME;
  const leniency = opts.leniency ?? 1;
  const u = prepareStroke(userPoints, frame);
  const ownFeatures = featuresOf(u, target, frame.confidence);
  const own = judge(ownFeatures, frame, leniency);

  let rival: { index: number; distance: number } | undefined;
  strokes.forEach((other, j) => {
    if (j === index || separation(target, other) < RIVAL_MIN_SEPARATION) return;
    const f = featuresOf(u, other, frame.confidence);
    if (rival && f.placedDistance >= rival.distance) return;
    if (judge(f, frame, leniency).ok) rival = { index: j, distance: f.placedDistance };
  });
  if (!rival) return own;
  if (!own.ok) return { ...own, drewStroke: rival.index };

  const clearlyCloser = ownFeatures.placedDistance > RIVAL_MIN_DISTANCE
    && rival.distance < RIVAL_RATIO * ownFeatures.placedDistance;
  return clearlyCloser
    ? { ok: false, score: Math.min(own.score, 0.49), reason: 'position', drewStroke: rival.index }
    : own;
}

export interface AcceptedStroke {
  /** What the learner drew, in box units. */
  points: readonly Point[];
  /** The model stroke it was accepted as. */
  target: string;
}

/**
 * Least-squares scale + offset mapping the model strokes onto what the learner
 * drew, shrunk toward "no change" while there is little evidence (one short
 * stroke says almost nothing about scale).
 */
export function estimateFrame(accepted: readonly AcceptedStroke[]): Frame {
  const us: Point[] = [];
  const ms: Point[] = [];
  let strokes = 0;
  for (const a of accepted) {
    if (a.points.length === 0) continue;
    us.push(...resample(cleanStroke(a.points), SAMPLE_POINTS));
    ms.push(...samplePath(a.target, SAMPLE_POINTS));
    strokes++;
  }
  if (strokes === 0) return IDENTITY_FRAME;

  const uc = centroid(us);
  const mc = centroid(ms);
  let cross = 0;
  let spread = 0;
  for (let i = 0; i < us.length; i++) {
    const mx = ms[i].x - mc.x;
    const my = ms[i].y - mc.y;
    cross += mx * (us[i].x - uc.x) + my * (us[i].y - uc.y);
    spread += mx * mx + my * my;
  }
  const variance = spread / ms.length;
  const rawScale = spread > 0 ? cross / spread : 1;
  const scaleTrust = variance / (variance + FRAME_SPREAD_PRIOR);
  const [lo, hi] = FRAME_SCALE_RANGE;
  const scale = Math.min(hi, Math.max(lo, 1 + (rawScale - 1) * scaleTrust));

  // The offset that best fits at this scale, trusted more with every stroke.
  // With no trust the frame scales about the box centre, as a learner would.
  const confidence = strokes / (strokes + FRAME_STROKE_PRIOR);
  const fitX = uc.x - scale * mc.x;
  const fitY = uc.y - scale * mc.y;
  const baseX = BOX_CENTER.x * (1 - scale);
  const baseY = BOX_CENTER.y * (1 - scale);
  return {
    scale,
    dx: baseX + (fitX - baseX) * confidence,
    dy: baseY + (fitY - baseY) * confidence,
    confidence,
  };
}

export interface CharacterMatch {
  /** Every stroke drawn, in order, and no extras. */
  ok: boolean;
  /** Mean stroke score over the expected strokes (missing strokes score 0). */
  score: number;
  /** One result per expected stroke. Strokes the learner never drew are `{ ok: false, score: 0 }` with no reason. */
  strokes: StrokeAttempt[];
  missing: number;
  extra: number;
  /** Expected-stroke indices where the learner drew a different stroke of the character instead (stroke-order slips). */
  outOfOrder: number[];
}

/**
 * Checks a whole character drawn without per-stroke feedback. Strokes are
 * compared in order; accepted ones refine the frame for the rest.
 */
export function matchCharacter(
  strokes: readonly string[],
  userStrokes: readonly (readonly Point[])[],
  opts: Omit<MatchOptions, 'frame'> = {},
): CharacterMatch {
  const accepted: AcceptedStroke[] = [];
  const results: StrokeAttempt[] = [];
  const outOfOrder: number[] = [];

  strokes.forEach((target, i) => {
    const drawn = userStrokes[i];
    if (!drawn) {
      results.push({ ok: false, score: 0 });
      return;
    }
    const r = matchStrokeOf(drawn, strokes, i, { ...opts, frame: estimateFrame(accepted) });
    results.push(r);
    if (r.ok) accepted.push({ points: drawn, target });
    else if (r.drewStroke !== undefined) outOfOrder.push(i);
  });

  const missing = Math.max(0, strokes.length - userStrokes.length);
  const extra = Math.max(0, userStrokes.length - strokes.length);
  const score = strokes.length ? results.reduce((s, r) => s + r.score, 0) / strokes.length : 0;
  return {
    ok: missing === 0 && extra === 0 && results.every((r) => r.ok),
    score,
    strokes: results,
    missing,
    extra,
    outOfOrder,
  };
}
