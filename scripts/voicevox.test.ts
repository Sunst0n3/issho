// @vitest-environment node
// shared/voicevox.ts against queries captured from the local engine (scripts/fixtures/voicevox, recorded by
// scripts/audio/record-fixtures.ts), so these tests never need VOICEVOX.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VOICES,
  accentFromQueries,
  clipRef,
  clipTextKey,
  gaAligned,
  normalizeMoras,
  phraseAccents,
  phraseOffsetsMs,
  queryMoras,
  readingMatches,
  rubyKana,
  rubyPlain,
  splitMoras,
  toKatakana,
  type VvQuery,
} from '../shared/voicevox.ts';

interface QueryFixture { engine: string; speaker: number; queries: Record<string, VvQuery> }
interface SentenceFixture { text: string; phrases: string[]; wavMs: number; query: VvQuery }

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/voicevox/${name}`, import.meta.url), 'utf8')) as T;
}

const hashi = fixture<QueryFixture>('hashi.json').queries;
const ame = fixture<QueryFixture>('ame.json').queries;
const hitoke = fixture<QueryFixture>('hitoke.json').queries;
const readings = fixture<QueryFixture>('readings.json').queries;
const story = fixture<SentenceFixture>('sentence-story.json');
const question = fixture<SentenceFixture>('sentence-question.json');
const questionDevoiced = fixture<SentenceFixture>('sentence-question-devoiced.json');

/** A synthetic query: phrases of [katakana moras, accent, pause?]; each mora 0.1 s (consonant 0.04 + vowel 0.06). */
function makeQuery(phrases: [string, number, boolean?][], extra: Partial<VvQuery> = {}): VvQuery {
  const mora = (text: string) => ({ text, consonant: 'k', consonant_length: 0.04, vowel: 'a', vowel_length: 0.06, pitch: 5 });
  return {
    accent_phrases: phrases.map(([moras, accent, pause]) => ({
      moras: splitMoras(moras).map(mora),
      accent,
      pause_mora: pause ? { text: '、', vowel: 'pau', vowel_length: 0.3, pitch: 0 } : null,
    })),
    speedScale: 1,
    pitchScale: 0,
    intonationScale: 1,
    volumeScale: 1,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    outputSamplingRate: 24000,
    outputStereo: false,
    ...extra,
  };
}

describe('voices', () => {
  it('uses No.7 アナウンス (30) and 青山龍星 ノーマル (13) with their credits', () => {
    expect(VOICES.f).toEqual({ speaker: 30, style: 'No.7 アナウンス', credit: 'VOICEVOX:No.7' });
    expect(VOICES.m).toEqual({ speaker: 13, style: '青山龍星 ノーマル', credit: 'VOICEVOX:青山龍星' });
  });

  it('builds clip refs with 0-based indexes', () => {
    expect(clipRef.kana('あ')).toBe('kana:あ');
    expect(clipRef.pitch('core:cw-0042')).toBe('pitch:core:cw-0042');
    expect(clipRef.grammarExample('wa-desu', 0)).toBe('grammar:wa-desu#ex0');
    expect(clipRef.grammarBuild('wa-desu', 3)).toBe('grammar:wa-desu#build3');
    expect(clipRef.story('st-l0-07', 3)).toBe('story:st-l0-07#3');
    expect(clipRef.rolePlay('rp-u01', 2)).toBe('rp:rp-u01#2');
    expect(clipRef.kanaRule('hira-yoon', 7)).toBe('kanaRule:hira-yoon#7');
  });
});

describe('ruby and kana', () => {
  it('drops readings and phrase marks like src/lib/ruby.ts', () => {
    expect(rubyPlain('{明日|あした}は／{晴|は}れ')).toBe('明日は晴れ');
    expect(rubyKana('{明日|あした}は／{晴|は}れ')).toBe('あしたははれ');
    expect(rubyPlain('ありがとう')).toBe('ありがとう');
  });

  it('converts hiragana to katakana only', () => {
    expect(toKatakana('きょうはコーヒー、ゔ')).toBe('キョウハコーヒー、ヴ');
  });

  it('splits kana into moras', () => {
    expect(splitMoras('きょうはっ')).toEqual(['きょ', 'う', 'は', 'っ']);
    expect(splitMoras('コーヒー')).toEqual(['コ', 'ー', 'ヒ', 'ー']);
    expect(splitMoras('ティーシャツ')).toEqual(['ティ', 'ー', 'シャ', 'ツ']);
    expect(splitMoras('しんぶん')).toEqual(['し', 'ん', 'ぶ', 'ん']);
  });

  it.each([
    ['せんせい', 'センセエ'],
    ['とうきょう', 'トオキョオ'],
    ['コーヒー', 'コオヒイ'],
    ['えきへ', 'エキエ'],
    ['ほんを', 'ホンオ'],
  ])('normalizes %s like the engine writes %s', (spelled, engine) => {
    expect(normalizeMoras(spelled)).toBe(normalizeMoras(engine));
  });

  it('accepts ゆう for いう, as 言う is said', () => {
    expect(normalizeMoras('どういういみ')).toBe(normalizeMoras('ドオユウイミ'));
    expect(normalizeMoras('という')).toBe(normalizeMoras('トイウ'));
    expect(normalizeMoras('いう')).toBe(normalizeMoras('ユウ'));
    expect(normalizeMoras('ゆき')).not.toBe(normalizeMoras('イキ'));
    // After an e-column mora the イ of いう becomes エ, and so must the ユ of ゆう (って言う said ってゆう).
    expect(normalizeMoras('っていう')).toBe(normalizeMoras('ッテユウ'));
    expect(normalizeMoras('ってゆう')).toBe(normalizeMoras('ッテイウ'));
    expect(normalizeMoras('せいゆう')).toBe(normalizeMoras('セエユウ'));
  });

  it('removes punctuation and spaces and folds ヅ/ヂ', () => {
    expect(normalizeMoras('はい、 げんき です。')).toBe(normalizeMoras('ハイゲンキデス'));
    expect(normalizeMoras('つづく')).toBe(normalizeMoras('ツズク'));
    expect(normalizeMoras('はなぢ')).toBe(normalizeMoras('ハナジ'));
    expect(normalizeMoras('はし')).not.toBe(normalizeMoras('ハシガ'));
  });
});

describe('clipTextKey', () => {
  it('gives split and whole-word ruby the same key', () => {
    expect(clipTextKey('f', '{食|た}べる')).toBe(clipTextKey('f', '{食べる|たべる}'));
    expect(clipTextKey('f', '{食べる|たべる}')).toBe('f|食べる|たべる');
  });

  it('leaves the reading empty when a kanji has no ruby', () => {
    expect(clipTextKey('f', '食べる')).toBe('f|食べる|');
    expect(clipTextKey('f', '{食|た}べて{行|い}く{所|ところ}、店')).toMatch(/\|$/);
  });

  it('uses the hiragana reading for kana text and keeps voices apart', () => {
    expect(clipTextKey('f', 'ありがとう')).toBe('f|ありがとう|ありがとう');
    expect(clipTextKey('m', 'コーヒー')).toBe('m|コーヒー|こーひー');
  });

  it('separates homographs with ruby and normalizes width, spaces and phrase marks', () => {
    expect(clipTextKey('f', '{箸|はし}')).not.toBe(clipTextKey('f', '{橋|はし}'));
    expect(clipTextKey('f', '{今日|きょう}')).not.toBe(clipTextKey('f', '{今日|こんにち}'));
    expect(clipTextKey('f', ' {私|わたし}は／ ｶﾞｸｾｲ  です ')).toBe('f|私は ガクセイ です|わたしは がくせい です');
  });
});

describe('readingMatches', () => {
  it('accepts the engine reading of long vowels and particles', () => {
    expect(readingMatches(readings['先生'], 'せんせい')).toBe(true);
    expect(readingMatches(readings['東京'], 'とうきょう')).toBe(true);
    expect(readingMatches(readings['コーヒー'], 'コーヒー')).toBe(true);
    expect(readingMatches(readings['駅へ'], 'えきへ')).toBe(true);
    expect(readingMatches(readings['本を'], 'ほんを')).toBe(true);
  });

  it('rejects a different reading', () => {
    expect(queryMoras(hitoke['人気'])).toBe('ニンキ');
    expect(readingMatches(hitoke['人気'], 'ひとけ')).toBe(false);
    expect(readingMatches(hitoke['ひとけ'], 'ひとけ')).toBe(true);
    expect(readingMatches(hitoke['人気がない。'], 'ひとけがない。')).toBe(false);
    expect(readingMatches(hitoke['ひとけがない。'], 'ひとけがない。')).toBe(true);
    expect(readingMatches(hashi['箸'], '')).toBe(false);
  });
});

describe('accentFromQueries', () => {
  it('tells 箸, 橋 and 端 apart only with が', () => {
    expect(hashi['橋'].accent_phrases[0].accent).toBe(hashi['端'].accent_phrases[0].accent);
    expect(accentFromQueries('はし', hashi['箸'], hashi['箸が'])).toEqual({ moras: ['ハ', 'シ'], drop: 1, type: 'atamadaka' });
    expect(accentFromQueries('はし', hashi['橋'], hashi['橋が'])).toEqual({ moras: ['ハ', 'シ'], drop: 2, type: 'odaka' });
    expect(accentFromQueries('はし', hashi['端'], hashi['端が'])).toEqual({ moras: ['ハ', 'シ'], drop: 0, type: 'heiban' });
  });

  it('falls back to the word alone, where a final accent reads as heiban', () => {
    expect(accentFromQueries('はし', hashi['橋'], null)).toMatchObject({ drop: 0, type: 'heiban' });
    expect(accentFromQueries('はし', hashi['箸'], null)).toMatchObject({ drop: 1, type: 'atamadaka' });
    expect(accentFromQueries('あめ', ame['雨'], ame['雨が'])).toMatchObject({ drop: 1, type: 'atamadaka' });
  });

  it('keeps long vowels as ー in the moras and finds nakadaka', () => {
    expect(accentFromQueries('コーヒー', readings['コーヒー'], null)).toEqual({
      moras: ['コ', 'ー', 'ヒ', 'ー'],
      drop: 3,
      type: 'nakadaka',
    });
    expect(accentFromQueries('せんせい', readings['先生'], null)).toMatchObject({ drop: 3, type: 'nakadaka' });
  });

  it('is null when the phrases or the reading do not line up', () => {
    expect(accentFromQueries('ひとけ', hitoke['人気'], null)).toBeNull();
    expect(accentFromQueries('ひとけがない', hitoke['ひとけがない。'], null)).toBeNull();
    // A が query of the wrong reading is ignored and the word alone decides.
    expect(accentFromQueries('はし', hashi['橋'], ame['雨が'])).toMatchObject({ drop: 0 });
  });

  it('types 1-mora words as heiban or atamadaka only', () => {
    expect(accentFromQueries('き', makeQuery([['キ', 1]]), makeQuery([['キガ', 1]]))).toMatchObject({ drop: 1, type: 'atamadaka' });
    expect(accentFromQueries('き', makeQuery([['キ', 1]]), makeQuery([['キガ', 2]]))).toMatchObject({ drop: 0, type: 'heiban' });
  });

  it('reports whether the が query lines up', () => {
    expect(gaAligned('はし', hashi['橋が'])).toBe(true);
    expect(gaAligned('はし', hashi['橋'])).toBe(false);
    expect(gaAligned('はし', ame['雨が'])).toBe(false);
  });
});

describe('phraseOffsetsMs', () => {
  const totalFrames = (q: VvQuery) => {
    const f = (s: number) => Math.round(s * 93.75);
    let frames = f(q.prePhonemeLength) + f(q.postPhonemeLength);
    for (const p of q.accent_phrases) {
      for (const m of p.moras) frames += f(m.consonant_length ?? 0) + f(m.vowel_length);
      if (p.is_interrogative && p.moras[p.moras.length - 1].pitch > 0) frames += f(0.15);
      if (p.pause_mora) frames += f(p.pause_mora.vowel_length);
    }
    return (frames / 93.75) * 1000;
  };

  it('matches the synthesized length of the fixture sentences (frame model)', () => {
    for (const s of [story, question, questionDevoiced]) {
      const q = { ...s.query, prePhonemeLength: 0.1, postPhonemeLength: 0.1, speedScale: 1 };
      expect(Math.abs(totalFrames(q) - s.wavMs)).toBeLessThanOrEqual(1);
    }
  });

  it('aligns the author phrases with the engine moras', () => {
    const q = { ...story.query, prePhonemeLength: 0.1, speedScale: 1 };
    const { offsets, aligned } = phraseOffsetsMs(q, story.phrases.map(rubyKana));
    expect(aligned).toBe(true);
    expect(offsets).toHaveLength(3);
    expect(offsets[0]).toBe(96); // 0.1 s = 9 frames at 93.75 frames/s
    expect(offsets[1]).toBeGreaterThan(offsets[0]);
    expect(offsets[2]).toBeGreaterThan(offsets[1]);
    // The second phrase starts after 私は and the comma pause.
    const p0 = q.accent_phrases[0];
    const f = (s: number) => Math.round(s * 93.75);
    const frames = f(0.1) + p0.moras.reduce((a, m) => a + f(m.consonant_length ?? 0) + f(m.vowel_length), 0) +
      f(p0.pause_mora?.vowel_length ?? 0);
    expect(offsets[1]).toBe(Math.round((frames / 93.75) * 1000));
  });

  it('counts the rising end of a question before the next phrase', () => {
    const q = { ...question.query, prePhonemeLength: 0.1, speedScale: 1 };
    const { offsets, aligned } = phraseOffsetsMs(q, question.phrases.map(rubyKana));
    expect(aligned).toBe(true);
    const p0 = q.accent_phrases[0];
    expect(p0.is_interrogative).toBe(true);
    const f = (s: number) => Math.round(s * 93.75);
    let frames = f(0.1) + f(0.15) + f(p0.pause_mora?.vowel_length ?? 0);
    for (const m of p0.moras) frames += f(m.consonant_length ?? 0) + f(m.vowel_length);
    expect(offsets[1]).toBe(Math.round((frames / 93.75) * 1000));
  });

  it('adds no rising end when the question ends on a devoiced mora (pitch 0)', () => {
    // Recorded: the same sentence is 149 ms shorter when the question's last mora is devoiced.
    expect(question.wavMs - questionDevoiced.wavMs).toBe(149);
    const q = { ...questionDevoiced.query, prePhonemeLength: 0.1, speedScale: 1 };
    const p0 = q.accent_phrases[0];
    expect(p0.is_interrogative).toBe(true);
    expect(p0.moras[p0.moras.length - 1].pitch).toBe(0);
    const { offsets, aligned } = phraseOffsetsMs(q, questionDevoiced.phrases.map(rubyKana));
    expect(aligned).toBe(true);
    const f = (s: number) => Math.round(s * 93.75);
    let frames = f(0.1) + f(p0.pause_mora?.vowel_length ?? 0);
    for (const m of p0.moras) frames += f(m.consonant_length ?? 0) + f(m.vowel_length);
    expect(offsets[1]).toBe(Math.round((frames / 93.75) * 1000));
    const voiced = phraseOffsetsMs({ ...question.query, prePhonemeLength: 0.1, speedScale: 1 }, question.phrases.map(rubyKana));
    expect(voiced.offsets[1] - offsets[1]).toBe(Math.round((f(0.15) / 93.75) * 1000));
  });

  it('walks synthetic moras and pauses and scales by speed', () => {
    // Frames: pre 9; each mora 4 + 6; the pause 28. The second phrase starts at 9 + 20 + 28 = 57 frames.
    const q = makeQuery([['アイ', 1, true], ['ウエオ', 3]]);
    expect(phraseOffsetsMs(q, ['あい', 'うえお'])).toEqual({ offsets: [96, 608], aligned: true });
    const fast = phraseOffsetsMs({ ...q, speedScale: 2 }, ['あい', 'うえお']);
    expect(fast.offsets[1]).toBeLessThan(400);
  });

  it('falls back to proportional offsets when the counts differ', () => {
    const q = makeQuery([['アイウエ', 1]]);
    const r = phraseOffsetsMs(q, ['あい', 'うえお']);
    expect(r.aligned).toBe(false);
    // 4 moras of 10 frames; the second phrase starts 2/5 of the way in: 9 + 40 · 2/5 = 25 frames.
    expect(r.offsets).toEqual([96, Math.round((25 / 93.75) * 1000)]);
  });
});

describe('phraseAccents', () => {
  it('lists each accent phrase with its nucleus, pauses left out', () => {
    expect(phraseAccents(story.query)).toEqual(story.query.accent_phrases.map((p) => [p.moras.map((m) => m.text).join(''), p.accent]));
    expect(phraseAccents(story.query)[0]).toEqual(['ワタシワ', 4]);
    expect(phraseAccents(question.query).map(([m]) => m).join('')).toBe(queryMoras(question.query));
  });
});
