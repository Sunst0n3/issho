import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccentFile, AudioManifest, PitchBoxRecord } from '../lib/types.ts';
import { db } from '../lib/db.ts';
import { pickPitchDrill, pitchCandidates, pitchOptions, pitchWeight, recordPitch, type PitchItem } from './pitch.ts';
import { seededRandom } from './random.ts';
import { at, EMPTY_MANIFEST, resetDb, wordInfoOf } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

describe('pitchCandidates', () => {
  it('drills only known words measured with が that have a pitch clip', () => {
    const accent: AccentFile = {
      'core:cw-0044': { moras: ['ヒ', 'ト'], drop: 0, type: 'heiban', withGa: true },
      'word:1002': { moras: ['ニ', 'ホ', 'ン'], drop: 2, type: 'nakadaka', withGa: true },
      'word:1004': { moras: ['ミ', 'ラ', 'イ'], drop: 1, type: 'atamadaka' }, // a verb-like entry: no が
      'word:1006': { moras: ['ホ', 'ン'], drop: 1, type: 'atamadaka', withGa: true }, // no clip
      'word:1007': { moras: ['ヒ', 'ト'], drop: 0, type: 'heiban', withGa: true }, // not known
    };
    const manifest: AudioManifest = {
      ...EMPTY_MANIFEST,
      byRef: { 'pitch:core:cw-0044': 'a', 'pitch:word:1002': 'b', 'pitch:word:1004': 'c', 'pitch:word:1007': 'd' },
    };
    const known = new Set(['core:cw-0044', 'word:1002', 'word:1004', 'word:1006']);
    const items = pitchCandidates(accent, manifest, (ref) => known.has(ref), wordInfoOf);
    expect(items.map((i) => [i.ref, i.clipRef, i.written])).toEqual([
      ['core:cw-0044', 'pitch:core:cw-0044', '人'],
      ['word:1002', 'pitch:word:1002', '日本'],
    ]);
  });
});

function item(n: number, kana: string, drop: number): PitchItem {
  return {
    ref: `word:${n}`, written: kana, kana,
    accent: { moras: [...kana], drop, type: drop === 0 ? 'heiban' : drop === 1 ? 'atamadaka' : 'nakadaka', withGa: true },
    clipRef: `pitch:word:${n}`,
  };
}

describe('pickPitchDrill', () => {
  it('weights heiban words up (≥ 1.6× their base share over 100 drills)', () => {
    // 10 % heiban, no long vowels or ん/っ.
    const cands = Array.from({ length: 200 }, (_, i) => item(i, `かき${i}`, i % 10 === 0 ? 0 : 1));
    const base = cands.filter((c) => c.accent.drop === 0).length / cands.length;
    let heiban = 0;
    let total = 0;
    const random = seededRandom(7);
    for (let draw = 0; draw < 100; draw++) {
      const picked = pickPitchDrill(cands, new Map(), '2026-03-20', random);
      total += picked.length;
      heiban += picked.filter((p) => p.accent.drop === 0).length;
    }
    expect(heiban / total).toBeGreaterThanOrEqual(1.6 * base);
  });

  it('weights long vowels and ん/っ', () => {
    expect(pitchWeight(item(1, 'かき', 1))).toBe(1);
    expect(pitchWeight(item(1, 'かき', 0))).toBe(2);
    expect(pitchWeight(item(1, 'こうこう', 1))).toBe(1.5);
    expect(pitchWeight(item(1, 'せんせい', 1))).toBe(2.25);
    expect(pitchWeight(item(1, 'コーヒー', 1))).toBe(1.5);
    expect(pitchWeight(item(1, 'きって', 0))).toBe(3);
  });

  it('puts minimal pairs in together', () => {
    const cands = [
      item(1, 'はし', 1), item(2, 'はし', 2), item(3, 'はし', 0),
      ...Array.from({ length: 30 }, (_, i) => item(100 + i, `ことば${i}`, 1)),
    ];
    for (let seed = 0; seed < 20; seed++) {
      const picked = pickPitchDrill(cands, new Map(), '2026-03-20', seededRandom(seed));
      const pairs = picked.filter((p) => p.kana === 'はし').length;
      expect([0, 3]).toContain(pairs);
      expect(picked.length).toBeGreaterThanOrEqual(8);
      expect(picked.length).toBeLessThanOrEqual(12);
    }
  });

  it('draws items due by box, topping up with the soonest when too few are due', () => {
    const cands = Array.from({ length: 10 }, (_, i) => item(i, `かな${i}`, 1));
    const boxes = new Map<string, PitchBoxRecord>(cands.slice(0, 7).map((c, i) => [c.ref, { ref: c.ref, box: 2, nextDay: `2026-03-${25 + i}`, seen: 3, correct: 3 }]));
    const picked = pickPitchDrill(cands, boxes, '2026-03-20', seededRandom(1));
    expect(picked.length).toBe(8);
    expect(picked.map((p) => p.ref)).toEqual(expect.arrayContaining(['word:7', 'word:8', 'word:9', 'word:0', 'word:1', 'word:2', 'word:3', 'word:4']));
  });
});

describe('recordPitch and options', () => {
  it('moves the box up on a right answer and back to 0 on a wrong one', async () => {
    await recordPitch('word:1', true, at(2026, 3, 20));
    expect(await db.pitchBoxes.get('word:1')).toEqual({ ref: 'word:1', box: 1, nextDay: '2026-03-21', seen: 1, correct: 1 });
    await recordPitch('word:1', true, at(2026, 3, 21));
    expect(await db.pitchBoxes.get('word:1')).toMatchObject({ box: 2, nextDay: '2026-03-24' });
    for (let i = 0; i < 4; i++) await recordPitch('word:1', true, at(2026, 3, 24));
    expect(await db.pitchBoxes.get('word:1')).toMatchObject({ box: 4, nextDay: '2026-04-07' });
    await recordPitch('word:1', false, at(2026, 4, 7));
    expect(await db.pitchBoxes.get('word:1')).toMatchObject({ box: 0, nextDay: '2026-04-07', seen: 7, correct: 6 });
  });

  it('offers drop 0 to n for a word of n moras', () => {
    expect(pitchOptions(2)).toEqual([0, 1, 2]);
    expect(pitchOptions(0)).toEqual([0]);
  });
});
