// @vitest-environment node
//
// The matcher's thresholds (matcher.ts) are tuned against these tests.
// "Finger" strokes are KanjiVG strokes put through synthetic.ts: smooth
// gaussian wobble of σ 3–6 units, the whole character scaled 0.8–1.2 about
// the centre and shifted up to ±8, bell-shaped pen speed (1.5–7 units per
// event), up to 35% of events dropped, late landing / early lift / overshoot
// of up to 3 units and digitizer noise. All randomness is seeded.

import { describe, expect, it } from 'vitest';
import { CORE_CHARACTERS, HARD_CHARACTERS, STROKE_FIXTURES } from './fixtures.ts';
import { Rating } from 'ts-fsrs';
import { gradeForRecallWriting } from '../srs/answers.ts';
import {
  estimateFrame,
  hungarian,
  IDENTITY_FRAME,
  matchCharacter,
  matchCharacterUnordered,
  MISSING_COST,
  matchStroke,
  matchStrokeOf,
  strokeFeatures,
  type AcceptedStroke,
  type Frame,
  type StrokeMatch,
  STYLUS_LENIENCY,
} from './matcher.ts';
import { BOX_CENTER, pathStart, resample, samplePath, type Point } from './path.ts';
import {
  DEFAULT_PLACEMENT, FINGER, place, randomPlacement, scribble, seededRng, synthStroke, type HandOptions, type PlacementRange,
} from './synthetic.ts';

const TRIALS = 40;

interface Written {
  char: string;
  strokes: readonly string[];
  drawn: Point[][];
  /** frames[i]: the frame the pad would use for stroke i (from strokes 0..i-1). */
  frames: Frame[];
}

/** Every character written TRIALS times, with the frames a WritingPad would build up. */
function writeAll(chars: readonly string[], seedBase: number, range: PlacementRange = DEFAULT_PLACEMENT): Written[] {
  const out: Written[] = [];
  chars.forEach((char, c) => {
    const strokes = STROKE_FIXTURES[char];
    for (let t = 0; t < TRIALS; t++) {
      const rng = seededRng(seedBase + c * 1000 + t);
      const placement = randomPlacement(rng, range);
      const drawn = strokes.map((d) => synthStroke(d, placement, rng));
      const accepted: AcceptedStroke[] = [];
      const frames = strokes.map((d, i) => {
        const frame = estimateFrame(accepted);
        accepted.push({ points: drawn[i], target: d });
        return frame;
      });
      out.push({ char, strokes, drawn, frames });
    }
  });
  return out;
}

class Tally {
  n = 0;
  pass = 0;
  readonly passesBy = new Map<string, number>();
  readonly countBy = new Map<string, number>();
  readonly reasons = new Map<string, number>();

  add(key: string, r: StrokeMatch) {
    this.n++;
    this.countBy.set(key, (this.countBy.get(key) ?? 0) + 1);
    if (r.ok) {
      this.pass++;
      this.passesBy.set(key, (this.passesBy.get(key) ?? 0) + 1);
    } else {
      this.reasons.set(r.reason ?? 'none', (this.reasons.get(r.reason ?? 'none') ?? 0) + 1);
    }
  }

  get rate() {
    return this.pass / this.n;
  }

  rateOf(key: string) {
    return (this.passesBy.get(key) ?? 0) / (this.countBy.get(key) ?? 1);
  }

  /** Keys whose pass rate is above `limit`, for readable failure messages. */
  worstAbove(limit: number) {
    return [...this.countBy.keys()].filter((k) => this.rateOf(k) > limit).map((k) => `${k}: ${(this.rateOf(k) * 100).toFixed(0)}%`);
  }
}

const core = writeAll(CORE_CHARACTERS, 1);
const hard = writeAll(HARD_CHARACTERS, 50_000);

describe('matchStroke on synthetic finger strokes (core characters)', () => {
  it('accepts at least 95% of correct strokes, and at least 90% for every character', () => {
    const tally = new Tally();
    for (const w of core) {
      w.strokes.forEach((d, i) => tally.add(w.char, matchStroke(w.drawn[i], d, { frame: w.frames[i] })));
    }
    expect(tally.rate).toBeGreaterThanOrEqual(0.95);
    for (const ch of CORE_CHARACTERS) expect(tally.rateOf(ch), ch).toBeGreaterThanOrEqual(0.9);
  });

  it('rejects at least 95% of reversed strokes, naming the direction', () => {
    const tally = new Tally();
    for (const w of core) {
      w.strokes.forEach((d, i) => tally.add(w.char, matchStroke([...w.drawn[i]].reverse(), d, { frame: w.frames[i] })));
    }
    expect(1 - tally.rate).toBeGreaterThanOrEqual(0.95);
    expect((tally.reasons.get('direction') ?? 0) / (tally.n - tally.pass)).toBeGreaterThanOrEqual(0.9);
  });

  it('rejects at least 95% of other strokes drawn as the first stroke (no frame yet)', () => {
    const tally = new Tally();
    for (const w of core) {
      w.strokes.forEach((_, j) => {
        if (j > 0) tally.add(`${w.char} 1←${j + 1}`, matchStroke(w.drawn[j], w.strokes[0]));
      });
    }
    expect(1 - tally.rate).toBeGreaterThanOrEqual(0.95);
  });

  it('rejects at least 95% of other strokes drawn in place of a later stroke', () => {
    const tally = new Tally();
    const nextOnly = new Tally();
    for (const w of core) {
      w.strokes.forEach((d, i) => {
        if (i === 0) return;
        w.strokes.forEach((_, j) => {
          if (j === i) return;
          const r = matchStroke(w.drawn[j], d, { frame: w.frames[i] });
          tally.add(`${w.char} ${i + 1}←${j + 1}`, r);
          if (j === i + 1) nextOnly.add(w.char, r);
        });
      });
    }
    expect(1 - tally.rate).toBeGreaterThanOrEqual(0.95);
    expect(1 - nextOnly.rate).toBeGreaterThanOrEqual(0.95);
  });

  it('rejects at least 95% of random scribbles', () => {
    const rng = seededRng(424242);
    const all = CORE_CHARACTERS.flatMap((c) => STROKE_FIXTURES[c]);
    const tally = new Tally();
    for (let t = 0; t < 1500; t++) {
      const target = all[Math.floor(rng() * all.length)];
      tally.add('scribble', matchStroke(scribble(rng), target));
    }
    expect(1 - tally.rate).toBeGreaterThanOrEqual(0.95);
  });
});

describe('matchStrokeOf: telling neighbouring strokes apart', () => {
  it('keeps the same acceptance as matchStroke on the core characters', () => {
    const tally = new Tally();
    for (const w of core) {
      w.strokes.forEach((_, i) => tally.add(w.char, matchStrokeOf(w.drawn[i], w.strokes, i, { frame: w.frames[i] })));
    }
    expect(tally.rate).toBeGreaterThanOrEqual(0.95);
  });

  it('never systematically confuses two strokes of a core character', () => {
    // With matchStroke alone the weakest pairs are first strokes (no frame yet)
    // and 右 5 drawn for 4 (bottom vs. top-and-right of 口, sharing an end
    // point), each passing ~5–15% of the time. Comparing against the other
    // strokes brings every pair down to a few percent.
    const tally = new Tally();
    for (const w of core) {
      w.strokes.forEach((_, i) => {
        w.strokes.forEach((_, j) => {
          if (j !== i) tally.add(`${w.char} ${i + 1}←${j + 1}`, matchStrokeOf(w.drawn[j], w.strokes, i, { frame: w.frames[i] }));
        });
      });
    }
    expect(1 - tally.rate).toBeGreaterThanOrEqual(0.99);
    expect(tally.worstAbove(0.15)).toEqual([]);
  });

  it('rejects wrong strokes in dense and parallel characters that matchStroke alone lets through', () => {
    const plain = new Tally();
    const withRivals = new Tally();
    const correct = new Tally();
    for (const w of hard) {
      w.strokes.forEach((d, i) => {
        correct.add(w.char, matchStrokeOf(w.drawn[i], w.strokes, i, { frame: w.frames[i] }));
        w.strokes.forEach((_, j) => {
          if (j === i) return;
          const key = `${w.char} ${i + 1}←${j + 1}`;
          plain.add(key, matchStroke(w.drawn[j], d, { frame: w.frames[i] }));
          withRivals.add(key, matchStrokeOf(w.drawn[j], w.strokes, i, { frame: w.frames[i] }));
        });
      });
    }
    expect(correct.rate).toBeGreaterThanOrEqual(0.95);
    expect(1 - withRivals.rate).toBeGreaterThanOrEqual(0.95);
    expect(withRivals.rate).toBeLessThan(plain.rate / 3);
    // Documented exceptions: same-shape horizontal strokes only ~10 units
    // apart (書 1–5 and 8–10, 言 3/4) are within the wobble of a finger, so a
    // stroke-order slip between neighbours passes ~5–25% of the time
    // (measured over 400 trials each). Every other pair stays in low single digits.
    const exceptions = new Set([
      '書 1←2', '書 2←1', '書 1←3', '書 3←1', '書 2←3', '書 3←2', '書 3←4', '書 4←3', '書 4←5', '書 5←4',
      '書 8←9', '書 9←8', '書 9←10', '書 10←9', '言 3←4', '言 4←3',
    ]);
    for (const k of withRivals.worstAbove(0.2)) {
      expect(exceptions.has(k.split(':')[0]), k).toBe(true);
    }
    expect(withRivals.worstAbove(0.45)).toEqual([]);
  });

  it('names the stroke that was drawn instead', () => {
    const three = STROKE_FIXTURES['三'];
    const second = samplePath(three[1], 20);
    const r = matchStrokeOf(second, three, 0);
    expect(r.ok).toBe(false);
    expect(r.drewStroke).toBe(1);
    // Drawing the right stroke reports no rival.
    const right = matchStrokeOf(samplePath(three[0], 20), three, 0);
    expect(right.ok).toBe(true);
    expect(right.drewStroke).toBeUndefined();
  });

  it('accepts twin strokes, like the two ticks of a dakuten, for each other', () => {
    const ticks = ['M72,14c1.5,2,3,4.5,4,7.5', 'M79,12c1.5,2,3,4.5,4,7.5'];
    expect(matchStrokeOf(samplePath(ticks[1], 12), ticks, 0).ok).toBe(true);
    expect(matchStrokeOf(samplePath(ticks[0], 12), ticks, 1).ok).toBe(true);
  });

  it('rejects an out-of-range index', () => {
    expect(() => matchStrokeOf([{ x: 1, y: 1 }], ['M0,0L10,10'], 3)).toThrow(RangeError);
  });
});

describe('stylus leniency', () => {
  // A pen: less wobble, steadier speed, cleaner landing and lift than a finger.
  const STYLUS: HandOptions = {
    jitter: [1.5, 3], wobbleSpacing: [12, 24], step: [1, 4], drop: [0, 0.2], sensorNoise: 0.3, endTrim: 1.5, overshoot: 1.5,
  };

  function acceptance(chars: readonly string[], hand: HandOptions, leniency: number) {
    let ok = 0;
    let n = 0;
    chars.forEach((char, c) => {
      const strokes = STROKE_FIXTURES[char];
      for (let t = 0; t < TRIALS; t++) {
        const rng = seededRng(7 + c * 1000 + t);
        const placement = randomPlacement(rng);
        const drawn = strokes.map((d) => synthStroke(d, placement, rng, hand));
        const accepted: AcceptedStroke[] = [];
        strokes.forEach((d, i) => {
          n++;
          if (matchStrokeOf(drawn[i], strokes, i, { frame: estimateFrame(accepted), leniency }).ok) ok++;
          accepted.push({ points: drawn[i], target: d });
        });
      }
    });
    return ok / n;
  }

  it('is stricter than a finger, and still accepts pen strokes (and nearly all finger ones)', () => {
    expect(STYLUS_LENIENCY).toBeLessThan(1);
    expect(acceptance(CORE_CHARACTERS, STYLUS, STYLUS_LENIENCY)).toBeGreaterThanOrEqual(0.98);
    expect(acceptance(HARD_CHARACTERS, STYLUS, STYLUS_LENIENCY)).toBeGreaterThanOrEqual(0.98);
    expect(acceptance(CORE_CHARACTERS, FINGER, STYLUS_LENIENCY)).toBeGreaterThanOrEqual(0.95);
  });

  it('lets fewer wrong strokes through in dense characters', () => {
    const wrongAccepted = (leniency: number) => {
      let ok = 0;
      for (const w of hard) {
        w.strokes.forEach((d, i) => {
          if (i === 0) return;
          w.strokes.forEach((_, j) => { if (j !== i && matchStroke(w.drawn[j], d, { frame: w.frames[i], leniency }).ok) ok++; });
        });
      }
      return ok;
    };
    expect(wrongAccepted(STYLUS_LENIENCY)).toBeLessThan(wrongAccepted(1));
  });
});

describe('matchStroke reasons and scores', () => {
  const vertical = 'M54.5,15 L54.5,95';
  const line = (x0: number, y0: number, x1: number, y1: number, n = 20): Point[] =>
    Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1) }));

  it('scores a perfect copy near 1', () => {
    const r = matchStroke(samplePath(STROKE_FIXTURES['水'][0], 50), STROKE_FIXTURES['水'][0]);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThan(0.95);
  });

  it('ok exactly when score ≥ 0.5', () => {
    for (const shift of [0, 10, 20, 30, 40, 60]) {
      const r = matchStroke(line(54.5 + shift, 15, 54.5 + shift, 95), vertical);
      expect(r.ok).toBe(r.score >= 0.5);
    }
  });

  it('calls taps and stubs too short', () => {
    expect(matchStroke([], vertical)).toMatchObject({ ok: false, reason: 'too-short' });
    expect(matchStroke([{ x: 54.5, y: 15 }], vertical)).toMatchObject({ ok: false, reason: 'too-short' });
    expect(matchStroke(line(54.5, 15, 54.5, 35), vertical)).toMatchObject({ ok: false, reason: 'too-short' });
  });

  it('calls a backwards stroke a direction mistake', () => {
    expect(matchStroke(line(54.5, 95, 54.5, 15), vertical)).toMatchObject({ ok: false, reason: 'direction' });
    const hachi = STROKE_FIXTURES['八'][1];
    expect(matchStroke([...samplePath(hachi, 30)].reverse(), hachi)).toMatchObject({ ok: false, reason: 'direction' });
  });

  it('calls the right stroke in the wrong place a position mistake', () => {
    expect(matchStroke(line(10, 15, 10, 95), vertical)).toMatchObject({ ok: false, reason: 'position' });
  });

  it('calls a zig-zag along the right path a shape mistake', () => {
    // Densely sampled, as pointer events would be.
    const corners = Array.from({ length: 9 }, (_, i) => ({ x: 54.5 + (i % 2 ? 22 : -22), y: 15 + i * 10 }));
    expect(matchStroke(resample(corners, 300), vertical)).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('is more forgiving with a higher leniency, but never of direction', () => {
    const offset = line(54.5 + 26, 15, 54.5 + 26, 95);
    expect(matchStroke(offset, vertical).ok).toBe(false);
    expect(matchStroke(offset, vertical, { leniency: 1.4 }).ok).toBe(true);
    expect(matchStroke(line(54.5, 95, 54.5, 15), vertical, { leniency: 3 }).ok).toBe(false);
  });

  it('exposes the raw features', () => {
    const f = strokeFeatures(line(54.5, 15, 54.5, 95), vertical);
    expect(f.meanDistance).toBeLessThan(0.5);
    expect(f.targetLength).toBeCloseTo(80, 5);
    expect(f.chordCosine).toBeCloseTo(1, 5);
  });
});

describe('writing smaller than the box, as on a phone', () => {
  // The whole character at 60–75% of the box. The first stroke has no frame
  // yet, so it lands on an inner neighbour (書's top box on its second line,
  // 海's first dot on its second): compared at face value it was rejected as
  // that stroke up to ~20% of the time.
  const SMALL: PlacementRange = { scale: [0.6, 0.75], offset: 4 };
  const chars = [...HARD_CHARACTERS, '海'];
  const small = writeAll(chars, 70_000, SMALL);

  it('accepts at least 95% of first strokes, and of all strokes, for every character', () => {
    const first = new Tally();
    const all = new Tally();
    for (const w of small) {
      first.add(w.char, matchStrokeOf(w.drawn[0], w.strokes, 0));
      w.strokes.forEach((_, i) => all.add(w.char, matchStrokeOf(w.drawn[i], w.strokes, i, { frame: w.frames[i] })));
    }
    for (const ch of chars) {
      expect(first.rateOf(ch), `${ch} first stroke`).toBeGreaterThanOrEqual(0.95);
      expect(all.rateOf(ch), ch).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('still rejects at least 95% of other strokes drawn first', () => {
    const tally = new Tally();
    for (const w of small) {
      w.strokes.forEach((_, j) => {
        if (j > 0) tally.add(`${w.char} 1←${j + 1}`, matchStrokeOf(w.drawn[j], w.strokes, 0));
      });
    }
    expect(1 - tally.rate).toBeGreaterThanOrEqual(0.95);
  });
});

describe('dots', () => {
  // ㇔ dots are 9–24 units long; on a phone a finger often just dabs or taps them.
  const kai = STROKE_FIXTURES['海'];
  const hitsu = STROKE_FIXTURES['必'];
  const cases: Array<[string, readonly string[], number]> = [['海 1', kai, 0], ['海 2', kai, 1], ['必 1', hitsu, 0]];
  const frameFor = (strokes: readonly string[], i: number) =>
    estimateFrame(strokes.slice(0, i).map((target) => ({ points: samplePath(target, 20), target })));
  const middle = (d: string) => samplePath(d, 3)[1];
  const dab = (p: Point, angle: number, len = 3): Point[] =>
    [p, { x: p.x + Math.cos(angle) * len, y: p.y + Math.sin(angle) * len }];

  it('accepts a dot tapped, or dabbed in any direction, where it belongs', () => {
    for (const [name, strokes, i] of cases) {
      const frame = frameFor(strokes, i);
      const p = middle(strokes[i]);
      expect(matchStrokeOf([p], strokes, i, { frame }), `${name} tap`).toMatchObject({ ok: true });
      for (let k = 0; k < 8; k++) {
        expect(matchStrokeOf(dab(p, (k * Math.PI) / 4), strokes, i, { frame }).ok, `${name} dab ${k * 45}°`).toBe(true);
      }
    }
  });

  it('rejects a dab away from the dot, and a dot drawn backwards', () => {
    for (const [name, strokes, i] of cases) {
      const frame = frameFor(strokes, i);
      expect(matchStrokeOf(dab({ x: 90, y: 90 }, 0), strokes, i, { frame }).ok, name).toBe(false);
      const backwards = [...samplePath(strokes[i], 12)].reverse();
      expect(matchStrokeOf(backwards, strokes, i, { frame }), name).toMatchObject({ ok: false, reason: 'direction' });
    }
  });

  it('still calls a dab too short for a long stroke', () => {
    const ki = STROKE_FIXTURES['木'];
    expect(matchStrokeOf(dab(pathStart(ki[1]), Math.PI / 2), ki, 1)).toMatchObject({ ok: false, reason: 'too-short' });
  });
});

describe('estimateFrame', () => {
  const ta = STROKE_FIXTURES['田'];
  const placement = { scale: 0.75, dx: 6, dy: -5 };
  const drawn = ta.map((d) => samplePath(d, 32).map((p) => place(p, placement)));

  it('is the identity with nothing drawn', () => {
    expect(estimateFrame([])).toEqual(IDENTITY_FRAME);
    expect(estimateFrame([{ points: [], target: ta[0] }])).toEqual(IDENTITY_FRAME);
  });

  it('recovers a character drawn small and off-centre, gaining confidence per stroke', () => {
    const one = estimateFrame([{ points: drawn[0], target: ta[0] }]);
    const all = estimateFrame(ta.map((target, i) => ({ points: drawn[i], target })));
    expect(all.confidence).toBeGreaterThan(one.confidence);
    expect(all.scale).toBeGreaterThan(0.75);
    expect(all.scale).toBeLessThan(0.85);

    // Where the frame says the box centre lands vs. where it really lands.
    const truth = place(BOX_CENTER, placement);
    const predicted = { x: BOX_CENTER.x * all.scale + all.dx, y: BOX_CENTER.y * all.scale + all.dy };
    expect(Math.hypot(predicted.x - truth.x, predicted.y - truth.y)).toBeLessThan(3);
  });

  it('makes a small, shifted character match more tightly', () => {
    const accepted = ta.slice(0, 4).map((target, i) => ({ points: drawn[i], target }));
    const frame = estimateFrame(accepted);
    const withFrame = strokeFeatures(drawn[4], ta[4], frame).meanDistance;
    const without = strokeFeatures(drawn[4], ta[4]).meanDistance;
    expect(withFrame).toBeLessThan(without / 2);
  });
});

describe('matchCharacter', () => {
  const ki = STROKE_FIXTURES['木'];
  const clean = ki.map((d) => samplePath(d, 24));

  it('accepts a correctly written character', () => {
    const rng = seededRng(7);
    const placement = randomPlacement(rng);
    const r = matchCharacter(ki, ki.map((d) => synthStroke(d, placement, rng)));
    expect(r).toMatchObject({ ok: true, missing: 0, extra: 0, outOfOrder: [] });
    expect(r.score).toBeGreaterThan(0.5);
  });

  it('reports strokes written out of order', () => {
    // 木: the two diagonals (strokes 3 and 4) swapped.
    const r = matchCharacter(ki, [clean[0], clean[1], clean[3], clean[2]]);
    expect(r.ok).toBe(false);
    expect(r.strokes.map((s) => s.ok)).toEqual([true, true, false, false]);
    expect(r.outOfOrder).toEqual([2, 3]);
  });

  it('counts missing and extra strokes', () => {
    const short = matchCharacter(ki, clean.slice(0, 2));
    expect(short).toMatchObject({ ok: false, missing: 2, extra: 0 });
    expect(short.strokes[3]).toEqual({ ok: false, score: 0 });
    expect(short.score).toBeLessThan(0.6);

    const long = matchCharacter(ki, [...clean, clean[0]]);
    expect(long).toMatchObject({ ok: false, missing: 0, extra: 1 });
  });
});

describe('hungarian', () => {
  it('finds the minimum-cost assignment of a known 4×4 matrix', () => {
    const cost = [
      [82, 83, 69, 92],
      [77, 37, 49, 92],
      [11, 69, 5, 86],
      [8, 9, 98, 23],
    ];
    const cols = hungarian(cost);
    expect(cols).toEqual([2, 1, 0, 3]);
    expect(cols.reduce((sum, c, r) => sum + cost[r][c], 0)).toBe(140);
  });

  it('handles empty and 1×1 matrices, and refuses a non-square one', () => {
    expect(hungarian([])).toEqual([]);
    expect(hungarian([[3]])).toEqual([0]);
    expect(() => hungarian([[1, 2]])).toThrow(RangeError);
  });

  it('agrees with brute force on random matrices', () => {
    const rng = seededRng(99);
    const permutations = (n: number): number[][] =>
      n === 0 ? [[]] : permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)]));
    for (let trial = 0; trial < 30; trial++) {
      const n = 2 + (trial % 4);
      const cost = Array.from({ length: n }, () => Array.from({ length: n }, () => Math.round(rng() * 20)));
      const best = Math.min(...permutations(n).map((p) => p.reduce((s, c, r) => s + cost[r][c], 0)));
      expect(hungarian(cost).reduce((s, c, r) => s + cost[r][c], 0)).toBe(best);
    }
  });
});

describe('matchCharacterUnordered', () => {
  const written = (char: string, seed: number) => {
    const strokes = STROKE_FIXTURES[char];
    const rng = seededRng(seed);
    const placement = randomPlacement(rng);
    return { strokes, drawn: strokes.map((d) => synthStroke(d, placement, rng)) };
  };
  const grade = (char: string, m: ReturnType<typeof matchCharacterUnordered>) => gradeForRecallWriting({
    strokeCount: STROKE_FIXTURES[char].length,
    missing: m.missing.length,
    extra: m.extra.length,
    unmatched: m.unmatched.length,
    hintUsed: false,
  });

  it('accepts characters written in order, with no slips', () => {
    for (const [i, char] of [...'木日右水書'].entries()) {
      const { strokes, drawn } = written(char, 300 + i);
      const m = matchCharacterUnordered(strokes, drawn);
      expect(m, char).toMatchObject({ ok: true, missing: [], extra: [], unmatched: [], orderSlips: [] });
      expect(m.assignment).toEqual(strokes.map((_, k) => k));
    }
  });

  it('accepts correct strokes in a shuffled order and reports the slips', () => {
    for (const [i, char] of [...'木日右田'].entries()) {
      const { strokes, drawn } = written(char, 400 + i);
      // Last stroke first: every other stroke stays in order, so exactly one slip.
      const order = [strokes.length - 1, ...strokes.slice(0, -1).map((_, k) => k)];
      const m = matchCharacterUnordered(strokes, order.map((k) => drawn[k]));
      expect(m.ok, char).toBe(true);
      expect(m.assignment[strokes.length - 1], char).toBe(0);
      expect(m.orderSlips, char).toEqual([{ expected: strokes.length - 1, drawnAt: 0 }]);
      expect(grade(char, m)).toBe(Rating.Good);
    }
  });

  it('calls one stroke of 木 left out missing, graded Again', () => {
    const { strokes, drawn } = written('木', 501);
    const m = matchCharacterUnordered(strokes, [drawn[0], drawn[1], drawn[3]]);
    expect(m).toMatchObject({ ok: false, missing: [2], extra: [], unmatched: [] });
    expect(m.assignment).toEqual([0, 1, null, 2]);
    expect(grade('木', m)).toBe(Rating.Again);
  });

  it('calls one sloppy stroke in a 10-stroke kanji (書) unmatched, graded Hard', () => {
    const { strokes, drawn } = written('書', 502);
    expect(strokes).toHaveLength(10);
    const sloppy = drawn.map((pts, k) => (k === 3 ? [...pts].reverse() : pts));
    const m = matchCharacterUnordered(strokes, sloppy);
    expect(m).toMatchObject({ ok: false, missing: [], extra: [], unmatched: [3] });
    expect(m.assignment[3]).toBe(3);
    expect(grade('書', m)).toBe(Rating.Hard);
  });

  it('calls one extra stroke extra, graded Again', () => {
    const { strokes, drawn } = written('木', 503);
    const m = matchCharacterUnordered(strokes, [...drawn, scribble(seededRng(5))]);
    expect(m).toMatchObject({ ok: false, missing: [], extra: [4], unmatched: [] });
    expect(grade('木', m)).toBe(Rating.Again);
  });

  it('ignores empty strokes and pads with MISSING_COST', () => {
    const { strokes, drawn } = written('人', 504);
    const m = matchCharacterUnordered(strokes, [drawn[0], [], drawn[1]]);
    expect(m.ok).toBe(true);
    expect(m.assignment).toEqual([0, 2]);
    expect(MISSING_COST).toBeGreaterThan(2);
  });

  it('reports nothing drawn as every stroke missing', () => {
    const m = matchCharacterUnordered(STROKE_FIXTURES['口'], []);
    expect(m).toMatchObject({ ok: false, missing: [0, 1, 2], extra: [], unmatched: [] });
  });
});
