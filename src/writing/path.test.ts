// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STROKE_FIXTURES } from './fixtures.ts';
import {
  distance,
  flattenPath,
  parsePath,
  PathParseError,
  pathLength,
  pathStart,
  polylineLength,
  resample,
  samplePath,
  smoothPath,
  startDirection,
  type Point,
} from './path.ts';

const close = (a: Point, b: Point, eps = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, -Math.log10(eps));
  expect(a.y).toBeCloseTo(b.y, -Math.log10(eps));
};

describe('parsePath', () => {
  it('splits numbers that run together: signs and repeated decimal points', () => {
    const segs = parsePath('M1-2.5L.5.5-1-1');
    expect(segs).toHaveLength(2);
    close(segs[0].from, { x: 1, y: -2.5 });
    close(segs[0].to, { x: 0.5, y: 0.5 });
    close(segs[1].to, { x: -1, y: -1 });
  });

  it('reads exponents and stray commas/whitespace', () => {
    const segs = parsePath('M 1e1 , 2E-1\n l 10 , 0');
    close(segs[0].from, { x: 10, y: 0.2 });
    close(segs[0].to, { x: 20, y: 0.2 });
  });

  it('treats extra pairs after M/m as line-tos (absolute and relative)', () => {
    const abs = parsePath('M0,0 10,0 10,10');
    expect(abs.map((s) => s.kind)).toEqual(['line', 'line']);
    close(abs[1].to, { x: 10, y: 10 });
    const rel = parsePath('m5,5 10,0 0,10');
    close(rel[0].from, { x: 5, y: 5 });
    close(rel[1].to, { x: 15, y: 15 });
  });

  it('repeats curve commands implicitly with relative coordinates chaining', () => {
    // KanjiVG style: one `c` followed by a second set of six numbers.
    const segs = parsePath('M54.89,15.5c-10.26,0-27.89,8.82-27.89,38.15c0,29.33,15.46,38.58,28.32,38.58');
    expect(segs).toHaveLength(2);
    close(segs[0].to, { x: 27, y: 53.65 });
    expect(segs[1].kind).toBe('cubic');
    close(segs[1].to, { x: 55.32, y: 92.23 });
    const implicit = parsePath('M0,0c1,0,2,0,3,0,1,0,2,0,3,0');
    expect(implicit).toHaveLength(2);
    close(implicit[1].to, { x: 6, y: 0 });
  });

  it('handles H/V, S/T reflections and Z', () => {
    const hv = parsePath('M1,1H5V9h-2v-3');
    expect(hv.map((s) => s.to)).toEqual([{ x: 5, y: 1 }, { x: 5, y: 9 }, { x: 3, y: 9 }, { x: 3, y: 6 }]);

    const s = parsePath('M0,0 C0,10 10,10 10,0 S20,-10 20,0');
    const second = s[1];
    expect(second.kind).toBe('cubic');
    if (second.kind === 'cubic') close(second.c1, { x: 10, y: -10 });

    const t = parsePath('M0,0 Q5,10 10,0 T20,0');
    const tq = t[1];
    expect(tq.kind).toBe('quad');
    if (tq.kind === 'quad') close(tq.c, { x: 15, y: -10 });

    // S without a preceding curve uses the current point as its first control.
    const lone = parsePath('M0,0 s5,5 10,0')[0];
    if (lone.kind === 'cubic') close(lone.c1, { x: 0, y: 0 });

    const z = parsePath('M0,0 L10,0 L10,10 Z');
    expect(z).toHaveLength(3);
    close(z[2].to, { x: 0, y: 0 });
  });

  it('rejects malformed paths and arcs', () => {
    expect(() => parsePath('10,10 L 5,5')).toThrow(PathParseError);
    expect(() => parsePath('M10,10 L5')).toThrow(PathParseError);
    expect(() => parsePath('M10,10 C1,2,3')).toThrow(PathParseError);
    expect(() => parsePath('M0,0 A5,5 0 0 1 10,0')).toThrow(/Arc/);
    expect(() => parsePath('M0,0 L1,1 #')).toThrow(/Unexpected character/);
    expect(parsePath('')).toEqual([]);
  });
});

describe('flattening and sampling', () => {
  it('measures straight lines exactly and curves closely', () => {
    expect(pathLength('M0,0 L30,40')).toBeCloseTo(50, 6);
    // Quarter circle of radius 50 as a cubic (k = 0.5523): length 25π ≈ 78.54.
    const k = 0.5523 * 50;
    expect(pathLength(`M50,0 C50,${k} ${k},50 0,50`)).toBeCloseTo((Math.PI * 50) / 2, 1);
  });

  it('samples n points evenly by arc length, keeping both ends', () => {
    const d = STROKE_FIXTURES['あ'][2];
    const pts = samplePath(d, 32);
    expect(pts).toHaveLength(32);
    close(pts[0], pathStart(d));
    const flat = flattenPath(d);
    close(pts[31], flat[flat.length - 1]);
    const step = pathLength(d) / 31;
    for (let i = 1; i < pts.length; i++) {
      // Chords on a curve are a little shorter than the arc between them.
      const gap = distance(pts[i - 1], pts[i]);
      expect(gap).toBeLessThanOrEqual(step + 1e-6);
      expect(gap).toBeGreaterThan(step * 0.8);
    }
  });

  it('resamples uneven polylines and degenerate input', () => {
    const pts = resample([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 0 }], 11);
    pts.forEach((p, i) => close(p, { x: i, y: 0 }));
    expect(resample([{ x: 3, y: 4 }], 5)).toEqual(Array(5).fill({ x: 3, y: 4 }));
    expect(resample([], 5)).toEqual([]);
    expect(polylineLength(pts)).toBeCloseTo(10, 9);
  });

  it('gives the initial heading of a stroke, ignoring the tiny entry serif', () => {
    // 木 stroke 2 starts with a short diagonal tick, then runs straight down.
    const dir = startDirection(STROKE_FIXTURES['木'][1]);
    expect(dir.y).toBeGreaterThan(0.9);
    // 木 stroke 1 runs left to right.
    expect(startDirection(STROKE_FIXTURES['木'][0]).x).toBeGreaterThan(0.95);
  });

  it('parses every fixture stroke', () => {
    for (const strokes of Object.values(STROKE_FIXTURES)) {
      for (const d of strokes) {
        const len = pathLength(d);
        expect(len).toBeGreaterThan(5);
        expect(len).toBeLessThan(400);
        for (const p of samplePath(d, 16)) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(109);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(109);
        }
      }
    }
  });

  it('draws smoothed ink paths, including a single dot', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 1, y: 2 }])).toMatch(/^M1 2L1\.01 2$/);
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }]);
    expect(d.startsWith('M0 0Q10 0 10 5')).toBe(true);
    expect(() => parsePath(d)).not.toThrow();
  });
});

const STROKES_JSON = new URL('../../public/data/strokes.json', import.meta.url);

describe.skipIf(!existsSync(STROKES_JSON))('public/data/strokes.json', () => {
  it('parses every stroke of every character', () => {
    const file = JSON.parse(readFileSync(STROKES_JSON, 'utf8')) as Record<string, string[]>;
    let count = 0;
    for (const strokes of Object.values(file)) {
      for (const d of strokes) {
        expect(samplePath(d, 8)).toHaveLength(8);
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});
