// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CurriculumUnit, WordEntry } from '../src/lib/types.ts';
import {
  buildCurriculum,
  compareKanjiPriority,
  computePhaseEnds,
  isKunWord,
  pickUnitWords,
  type CurriculumKanji,
} from './lib/curriculum.ts';

const kanji: CurriculumKanji[] = [
  { char: '森', grade: 1, strokeCount: 12 },
  { char: '体', jlptOld: 3, freq: 88, grade: 2, strokeCount: 7 },
  { char: '休', jlptOld: 4, freq: 642, grade: 1, strokeCount: 6 },
  { char: '林', freq: 1000, grade: 1, strokeCount: 8 },
  { char: '木', jlptOld: 4, freq: 317, grade: 1, strokeCount: 4 },
  { char: '本', jlptOld: 4, freq: 10, grade: 1, strokeCount: 5 },
  { char: '一', jlptOld: 4, freq: 2, grade: 1, strokeCount: 1 },
  { char: '日', jlptOld: 4, freq: 1, grade: 1, strokeCount: 4 },
  { char: '末', grade: 4, strokeCount: 5 },
];

const components = new Map<string, string[]>([
  ['本', ['木']],
  ['休', ['亻', '木']],
  ['体', ['亻', '本']],
  ['林', ['木']],
  ['森', ['木', '林']],
  ['末', ['木', '氺']],
]);

let nextId = 1000;
function word(written: string, kana: string, freqRank: number, pos = ['n'], meanings = ['x']): WordEntry {
  const chars = [...written].filter((ch) => /\p{Script=Han}/u.test(ch));
  return { id: String(nextId++), written, kana, meanings, pos, freqRank, kanji: [...new Set(chars)] };
}

const words = [
  word('日', 'ひ', 3),
  word('日', 'にち', 49, ['suf']),
  word('日本', 'にほん', 1),
  word('一', 'いち', 33),
  word('一つ', 'ひとつ', 1),
  word('一日', 'いちにち', 49),
  word('一人', 'ひとり', 2),
  word('木', 'き', 1),
  word('本', 'ほん', 49),
  word('本日', 'ほんじつ', 15),
  word('休日', 'きゅうじつ', 5),
  word('休み', 'やすみ', 10),
  word('休む', 'やすむ', 20),
  word('休業', 'きゅうぎょう', 4),
  word('林', 'はやし', 6),
];
const core = new Set(words.filter((w) => ['本', '休む', '一日'].includes(w.written)).map((w) => w.id));

const curriculum = buildCurriculum({ kanji, components, radicals: new Set(['亻', '氵']), words, coreWords: core });
const units = curriculum.units;
const byChar = new Map(units.map((u) => [u.char, u]));
const wordById = new Map(words.map((w) => [w.id, w]));
const written = (u: CurriculumUnit | undefined) => (u?.words ?? []).map((id) => wordById.get(id)!.written);

describe('kanji priority', () => {
  it('orders old JLPT 4, then JLPT 3, then the rest by frequency, grade and strokes', () => {
    const sorted = [...kanji].sort(compareKanjiPriority).map((k) => k.char);
    expect(sorted).toEqual(['日', '一', '本', '木', '休', '体', '林', '森', '末']);
  });
});

describe('buildCurriculum', () => {
  it('teaches components first, recursively, with radicals as their own units', () => {
    expect(units.map((u) => (u.type === 'radical' ? `[${u.char}]` : u.char)).join(' ')).toBe(
      '日 一 木 本 [亻] 休 体 林 森 末',
    );
    expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
  });

  it('ignores components that are neither kanji nor known radicals', () => {
    expect(byChar.has('氺')).toBe(false);
    expect(byChar.has('氵')).toBe(false);
  });

  it('gives each kanji up to three words whose kanji are all taught', () => {
    for (const u of units) {
      expect(u.words.length).toBeLessThanOrEqual(3);
      for (const id of u.words) {
        for (const ch of wordById.get(id)!.kanji) expect(byChar.get(ch)!.index).toBeLessThanOrEqual(u.index);
      }
    }
    expect(byChar.get('亻')!.words).toEqual([]);
    expect(written(byChar.get('本'))).toEqual(['本', '日本', '本日']);
    expect(written(byChar.get('林'))).toEqual(['林']);
    expect(written(byChar.get('森'))).toEqual([]);
  });

  it('uses each word once and never two words spelled the same in one unit', () => {
    const ids = units.flatMap((u) => u.words);
    expect(new Set(ids).size).toBe(ids.length);
    expect(written(byChar.get('日'))).toEqual(['日']);
    expect(byChar.get('日')!.words.map((id) => wordById.get(id)!.kana)).toEqual(['ひ']);
  });

  it('starts with the basic word, then the most frequent and shortest', () => {
    expect(written(byChar.get('一'))).toEqual(['一', '一つ', '一日']);
    expect(written(byChar.get('休'))).toEqual(['休む', '休日', '休み']);
  });

  it('uses each kanji\'s kun readings to find its native word', () => {
    const nagasa = word('長さ', 'ながさ', 7);
    const nagai = word('長い', 'ながい', 20, ['adj-i']);
    const { units: [unit] } = buildCurriculum({
      kanji: [{ char: '長', jlptOld: 4, freq: 12, strokeCount: 8, kun: ['なが.い'] }],
      components: new Map(),
      radicals: new Set(),
      words: [nagasa, nagai],
    });
    expect(unit.words).toEqual([nagai.id, nagasa.id]);
  });

  it('assigns phases from phaseEnds', () => {
    expect(curriculum.phaseEnds).toEqual({ 2: units.length, 3: units.length, 4: units.length });
    expect(units.every((u) => u.phase === 2)).toBe(true);
  });
});

describe('pickUnitWords', () => {
  it('skips affix-only entries for the first slot', () => {
    const picked = pickUnitWords('日', [word('日', 'じつ', 1, ['suf']), word('日', 'ひ', 40)]);
    expect(picked.map((w) => w.kana)).toEqual(['ひ']);
  });

  it('never opens with a bare prefix or suffix, even when it is the only basic word', () => {
    const fu = pickUnitWords('不', [word('不', 'ふ', 49, ['pref'], ['un-', 'non-']), word('不安', 'ふあん', 2)]);
    expect(fu.map((w) => w.written)).toEqual(['不安', '不']);
    const ta = word('多', 'た', 49, ['n', 'pref'], ['multi-']);
    const ooi = word('多い', 'おおい', 44, ['adj-i'], ['many']);
    const picked = pickUnitWords('多', [ta, ooi, word('多分', 'たぶん', 13, ['adv'])], new Set([ta.id, ooi.id]));
    expect(picked.map((w) => w.written)).toEqual(['多い', '多分', '多']);
    const teki = pickUnitWords('的', [word('的', 'てき', 3, ['suf', 'adj-na'], ['-ical']), word('目的', 'もくてき', 1)]);
    expect(teki.map((w) => w.written)).toEqual(['目的', '的']);
  });

  it('prefers the native (kun) word over derived nouns and on-reading nouns', () => {
    const nagasa = word('長さ', 'ながさ', 7);
    const nagai = word('長い', 'ながい', 20, ['adj-i']);
    const core = new Set([nagasa.id, nagai.id]);
    const picked = pickUnitWords('長', [nagasa, nagai, word('会長', 'かいちょう', 1)], core, ['なが.い']);
    expect(picked.map((w) => w.written)).toEqual(['長い', '会長', '長さ']);

    const saku = word('作', 'さく', 7);
    const tsukuru = word('作る', 'つくる', 49, ['v5r', 'vt']);
    const both = new Set([saku.id, tsukuru.id]);
    expect(pickUnitWords('作', [saku, tsukuru], both, ['つく.る'])[0].written).toBe('作る');
    expect(pickUnitWords('作', [saku, tsukuru], both)[0].written).toBe('作');
  });

  it('still opens with a counter when the kanji has no other basic word', () => {
    const picked = pickUnitWords('枚', [word('一枚', 'いちまい', 10), word('枚', 'まい', 49, ['ctr'])]);
    expect(picked.map((w) => w.written)).toEqual(['枚', '一枚']);
  });

  it('works without a basic word', () => {
    const picked = pickUnitWords('業', [word('休業', 'きゅうぎょう', 4), word('業界', 'ぎょうかい', 2)]);
    expect(picked.map((w) => w.written)).toEqual(['業界', '休業']);
  });
});

describe('isKunWord', () => {
  it('matches the kanji plus okurigana read with one of its kun readings', () => {
    const kun = ['うえ', 'あ.がる', 'のぼ.る'];
    expect(isKunWord('上', word('上', 'うえ', 49), kun)).toBe(true);
    expect(isKunWord('上', word('上がる', 'あがる', 13), kun)).toBe(true);
    expect(isKunWord('上', word('上', 'じょう', 49), kun)).toBe(false);
    expect(isKunWord('上', word('上がり', 'あがり', 8), kun)).toBe(false);
    expect(isKunWord('上', word('上々', 'じょうじょう', 13), kun)).toBe(false);
    expect(isKunWord('上', word('川上', 'かわかみ', 13), kun)).toBe(false);
  });
});

describe('computePhaseEnds', () => {
  it('ends phase 2 after the 300th kanji and phase 3 after the 800th', () => {
    const synthetic: CurriculumUnit[] = [];
    for (let k = 1; k <= 900; k++) {
      if (k % 50 === 0) synthetic.push({ index: synthetic.length, type: 'radical', char: `r${k}`, words: [], phase: 0 });
      synthetic.push({ index: synthetic.length, type: 'kanji', char: `k${k}`, words: [], phase: 0 });
    }
    const ends = computePhaseEnds(synthetic);
    expect(synthetic[ends['2'] - 1].char).toBe('k300');
    expect(synthetic[ends['3'] - 1].char).toBe('k800');
    expect(ends['4']).toBe(synthetic.length);
  });
});
