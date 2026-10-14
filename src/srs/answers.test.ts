import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { KanaEntry } from '../lib/types.ts';
import {
  choicesFrom,
  gradeFor,
  gradeForWriting,
  kanaMatches,
  meaningMatches,
  normalizeKana,
  romajiMatches,
  seededRandom,
  slipCount,
  toKana,
} from './answers.ts';

describe('toKana', () => {
  it.each([
    ['konnichiha', 'こんにちは'],
    ['kitte', 'きって'],
    ['shinbun', 'しんぶん'],
    ['kanji', 'かんじ'],
    ['minna', 'みんな'],
    ['onna', 'おんな'],
    ['konnnichiha', 'こんにちは'],
    ['konnyaku', 'こんにゃく'],
    ['sanpo', 'さんぽ'],
    ['shimbun', 'しんぶん'],
    ['matcha', 'まっちゃ'],
    ['zasshi', 'ざっし'],
    ['kocchi', 'こっち'],
    ['toukyou', 'とうきょう'],
    ['wo', 'を'],
  ])('%s → %s', (romaji, kana) => {
    expect(toKana(romaji)).toBe(kana);
  });

  it("handles n' and a final n", () => {
    expect(toKana("kin'en")).toBe('きんえん');
    expect(toKana("hon'ya")).toBe('ほんや');
    expect(toKana('honya')).toBe('ほにゃ');
    expect(toKana('hon’ya')).toBe('ほんや'); // iOS smart apostrophe
    expect(toKana('n')).toBe('ん');
    expect(toKana('nn')).toBe('ん');
    expect(toKana('hon')).toBe('ほん');
    expect(toKana('gakkō')).toBe('がっこう');
    expect(toKana('Kyôto')).toBe('きょうと');
  });

  it('makes small kana with x/l prefixes', () => {
    expect(toKana('xtsu')).toBe('っ');
    expect(toKana('ltu')).toBe('っ');
    expect(toKana('xtu')).toBe('っ');
    expect(toKana('ltsu')).toBe('っ');
    expect(toKana('xa')).toBe('ぁ');
    expect(toKana('lyo')).toBe('ょ');
    expect(toKana('kixyo')).toBe('きょ');
  });

  it('converts yōon and Hepburn spellings', () => {
    expect(toKana('kya')).toBe('きゃ');
    expect(toKana('sha')).toBe('しゃ');
    expect(toKana('shu')).toBe('しゅ');
    expect(toKana('cha')).toBe('ちゃ');
    expect(toKana('cho')).toBe('ちょ');
    expect(toKana('ja')).toBe('じゃ');
    expect(toKana('jo')).toBe('じょ');
    expect(toKana('jya')).toBe('じゃ');
    expect(toKana('fu')).toBe('ふ');
    expect(toKana('hu')).toBe('ふ');
    expect(toKana('shi')).toBe('し');
    expect(toKana('si')).toBe('し');
    expect(toKana('chi')).toBe('ち');
    expect(toKana('tsu')).toBe('つ');
    expect(toKana('tu')).toBe('つ');
    expect(toKana('ji')).toBe('じ');
    expect(toKana('di')).toBe('ぢ');
  });

  it("maps 'dzu' and 'du' to づ", () => {
    expect(toKana('dzu')).toBe('づ');
    expect(toKana('du')).toBe('づ');
    expect(toKana('tsudzuku')).toBe('つづく');
  });

  it('writes the long-vowel mark only in katakana mode', () => {
    expect(toKana('ko-hi-', { katakana: true })).toBe('コーヒー');
    expect(toKana('ko-hi-')).toBe('こ-ひ-');
    expect(toKana('ra-men', { katakana: true })).toBe('ラーメン');
    expect(toKana('vu', { katakana: true })).toBe('ヴ');
  });

  it('is case-insensitive, folds full-width letters and passes other text through', () => {
    expect(toKana('KONBANWA')).toBe('こんばんわ');
    expect(toKana('ｓｕｓｈｉ')).toBe('すし');
    expect(toKana('すushi')).toBe('すうし');
    expect(toKana('hai, desu')).toBe('はい, です');
  });

  it('keeps an unfinished syllable as romaji while typing', () => {
    expect(toKana('kon', { partial: true })).toBe('こn');
    expect(toKana('kitt', { partial: true })).toBe('きっt');
    expect(toKana('ky', { partial: true })).toBe('ky');
    expect(toKana('konn', { partial: true })).toBe('こん');
    expect(toKana('kya', { partial: true })).toBe('きゃ');
  });
});

describe('normalizeKana', () => {
  it('folds katakana to hiragana, trims and normalizes width', () => {
    expect(normalizeKana('  カタカナ ')).toBe('かたかな');
    expect(normalizeKana('ｶﾀｶﾅ')).toBe('かたかな');
    expect(normalizeKana('ﾊﾞｽ')).toBe('ばす');
    expect(normalizeKana('コーヒー')).toBe('こーひー');
  });
});

const kana = (char: string, romaji: string, altRomaji?: string[]): KanaEntry => ({
  char,
  romaji,
  altRomaji,
  script: 'hiragana',
  group: romaji,
  kind: 'basic',
  order: 0,
});

describe('romajiMatches', () => {
  it('accepts the Hepburn romaji, listed alternatives and IME spellings', () => {
    expect(romajiMatches('shi', kana('し', 'shi'))).toBe(true);
    expect(romajiMatches(' SHI ', kana('し', 'shi'))).toBe(true);
    expect(romajiMatches('si', kana('し', 'shi'))).toBe(true);
    expect(romajiMatches('tu', kana('つ', 'tsu'))).toBe(true);
    expect(romajiMatches('nn', kana('ん', 'n'))).toBe(true);
    expect(romajiMatches('o', kana('を', 'wo', ['o']))).toBe(true);
    expect(romajiMatches('kya', { ...kana('キャ', 'kya'), script: 'katakana', kind: 'yoon' })).toBe(true);
  });

  it('rejects wrong or empty answers', () => {
    expect(romajiMatches('su', kana('し', 'shi'))).toBe(false);
    expect(romajiMatches('', kana('し', 'shi'))).toBe(false);
    expect(romajiMatches('o', kana('を', 'wo'))).toBe(false);
  });
});

describe('kanaMatches', () => {
  it('compares kana typed directly or as romaji', () => {
    expect(kanaMatches('すいようび', 'すいようび')).toBe(true);
    expect(kanaMatches('suiyoubi', 'すいようび')).toBe(true);
    expect(kanaMatches('すいようひ', 'すいようび')).toBe(false);
    expect(kanaMatches('', 'すいようび')).toBe(false);
  });

  it('treats hiragana and katakana alike and ignores spaces and punctuation', () => {
    expect(kanaMatches('こーひー', 'コーヒー')).toBe(true);
    expect(kanaMatches('ko-hi-', 'コーヒー')).toBe(true);
    expect(kanaMatches('はい、そうです。', 'はいそうです')).toBe(true);
  });

  it('reads ruby markup and accepts any of several readings', () => {
    expect(kanaMatches('ashita', '{明日|あした}')).toBe(true);
    expect(kanaMatches('あす', ['あした', 'あす'])).toBe(true);
  });

  it('accepts Hepburn long vowels written with a macron or circumflex', () => {
    expect(kanaMatches('gakkō', 'がっこう')).toBe(true);
    expect(kanaMatches('Tōkyō', 'とうきょう')).toBe(true);
    expect(kanaMatches('ōkii', 'おおきい')).toBe(true);
    expect(kanaMatches('onēsan', 'おねえさん')).toBe(true);
    expect(kanaMatches('sensē', 'せんせい')).toBe(true);
    expect(kanaMatches('jûsho', 'じゅうしょ')).toBe(true);
    expect(kanaMatches('kōhī', ['コーヒー', 'こおひい'])).toBe(true);
    expect(kanaMatches('gakkō', 'がこう')).toBe(false);
  });

  it('reads "nn" before a vowel or y either as ん alone or as ん plus an n-syllable', () => {
    expect(kanaMatches('kinnyoubi', 'きんようび')).toBe(true);
    expect(kanaMatches("kin'youbi", 'きんようび')).toBe(true);
    expect(kanaMatches('konnyaku', 'こんにゃく')).toBe(true);
    expect(kanaMatches('minna', 'みんな')).toBe(true);
    expect(kanaMatches('minna', 'みな')).toBe(false);
  });
});

describe('meaningMatches', () => {
  it('is case- and punctuation-insensitive', () => {
    expect(meaningMatches('Water!', ['water'])).toBe(true);
    expect(meaningMatches('  good   MORNING ', ['good morning'])).toBe(true);
  });

  it('ignores a leading "to", "a" or "the"', () => {
    expect(meaningMatches('eat', ['to eat'])).toBe(true);
    expect(meaningMatches('to eat', ['eat'])).toBe(true);
    expect(meaningMatches('a book', ['book'])).toBe(true);
    expect(meaningMatches('the sun', ['sun'])).toBe(true);
  });

  it('accepts any listed meaning and each ";" alternative', () => {
    expect(meaningMatches('good afternoon', ['hello; good afternoon'])).toBe(true);
    expect(meaningMatches('person', ['man', 'person'])).toBe(true);
    expect(meaningMatches('dog', ['man', 'person'])).toBe(false);
  });

  it('accepts a meaning with or without its parenthesised part', () => {
    expect(meaningMatches('mother', ["(one's) mother"])).toBe(true);
    expect(meaningMatches("one's mother", ["(one's) mother"])).toBe(true);
    expect(meaningMatches('thank you', ['thank you (polite)'])).toBe(true);
  });

  it('forgives a small typo only in words of 5+ letters', () => {
    expect(meaningMatches('mountian', ['mountain'])).toBe(true);
    expect(meaningMatches('wter', ['water'])).toBe(true);
    expect(meaningMatches('rivr', ['river'])).toBe(true);
    expect(meaningMatches('sum', ['sun'])).toBe(false);
    expect(meaningMatches('fier', ['fire'])).toBe(false);
    expect(meaningMatches('mointian', ['mountain'])).toBe(false);
    expect(meaningMatches('enviornmant', ['environment'])).toBe(true);
  });

  it('forgives keyboard slips: doubled or stray keys, neighbouring keys, swapped letters', () => {
    expect(meaningMatches('waater', ['water'])).toBe(true);
    expect(meaningMatches('watrer', ['water'])).toBe(true);
    expect(meaningMatches('wqter', ['water'])).toBe(true);
    expect(meaningMatches('watre', ['water'])).toBe(true);
    expect(meaningMatches('mountein', ['mountain'])).toBe(true);
  });

  it('does not take a different word for a typo', () => {
    expect(meaningMatches('waiter', ['water'])).toBe(false);
    expect(meaningMatches('later', ['water'])).toBe(false);
    expect(meaningMatches('night', ['right'])).toBe(false);
    expect(meaningMatches('light', ['right'])).toBe(false);
    expect(meaningMatches('eight', ['eighty'])).toBe(false);
    expect(meaningMatches('eighty', ['eight'])).toBe(false);
    expect(meaningMatches('sixth', ['sixty'])).toBe(false);
    expect(meaningMatches('horse', ['house'])).toBe(false);
    expect(meaningMatches('mouse', ['house'])).toBe(false);
    expect(meaningMatches('month', ['mouth'])).toBe(false);
    expect(meaningMatches('write', ['white'])).toBe(false);
    expect(meaningMatches('ward', ['award'])).toBe(false);
  });

  it('judges each word of a phrase on its own length', () => {
    expect(meaningMatches('west exit', ['east exit'])).toBe(false);
    expect(meaningMatches('big mother', ['big brother'])).toBe(false);
    expect(meaningMatches('good mornig', ['good morning'])).toBe(true);
    expect(meaningMatches('goodmorning', ['good morning'])).toBe(true);
  });

  it('does not accept a typo that is really another known meaning', () => {
    expect(meaningMatches('block', ['black'])).toBe(true);
    expect(meaningMatches('block', ['black'], { notAccepted: ['block'] })).toBe(false);
    expect(meaningMatches('black', ['black'], { notAccepted: ['block'] })).toBe(true);
  });

  it('rejects empty input', () => {
    expect(meaningMatches('  ', ['water'])).toBe(false);
    expect(meaningMatches('the', ['water'])).toBe(false);
  });
});

describe('slipCount', () => {
  it('counts dropped letters, swaps, stray keys and near-key or vowel substitutions', () => {
    expect(slipCount('water', 'water')).toBe(0);
    expect(slipCount('water', 'wter')).toBe(1);
    expect(slipCount('water', 'watre')).toBe(1);
    expect(slipCount('water', 'watter')).toBe(1);
    expect(slipCount('water', 'wsater')).toBe(1);
    expect(slipCount('water', 'wqter')).toBe(1);
    expect(slipCount('separate', 'seperate')).toBe(1);
    expect(slipCount('environment', 'enviornmant')).toBe(2);
  });

  it('needs several slips for changes that are not typos', () => {
    expect(slipCount('water', 'waiter')).toBeGreaterThan(1);
    expect(slipCount('house', 'horse')).toBeGreaterThan(1);
    expect(slipCount('kitten', 'sitting')).toBeGreaterThan(2);
    expect(slipCount('water', 'xyz')).toBe(Infinity);
  });
});

describe('gradeFor', () => {
  it('maps objective answers to grades', () => {
    expect(gradeFor({ correct: true })).toBe(Rating.Good);
    expect(gradeFor({ correct: true, usedHint: true })).toBe(Rating.Hard);
    expect(gradeFor({ correct: true, retries: 1 })).toBe(Rating.Hard);
    expect(gradeFor({ correct: false })).toBe(Rating.Again);
    expect(gradeFor({ correct: false, usedHint: true, retries: 2 })).toBe(Rating.Again);
  });
});

describe('gradeForWriting', () => {
  it('maps writing outcomes to grades', () => {
    expect(gradeForWriting({ mistakes: 0, hintsUsed: 0, strokeCount: 4, gaveUp: false })).toBe(Rating.Good);
    expect(gradeForWriting({ mistakes: 1, hintsUsed: 0, strokeCount: 4, gaveUp: false })).toBe(Rating.Good);
    expect(gradeForWriting({ mistakes: 0, hintsUsed: 1, strokeCount: 4, gaveUp: false })).toBe(Rating.Hard);
    expect(gradeForWriting({ mistakes: 2, hintsUsed: 0, strokeCount: 4, gaveUp: false })).toBe(Rating.Hard);
    expect(gradeForWriting({ mistakes: 3, hintsUsed: 0, strokeCount: 4, gaveUp: false })).toBe(Rating.Again);
    expect(gradeForWriting({ mistakes: 0, hintsUsed: 0, strokeCount: 4, gaveUp: true })).toBe(Rating.Again);
  });

  it('counts failed strokes, not wrong tries, when the pad reports them', () => {
    // One stroke of こ missed twice, then shown automatically: 1 of 2 strokes failed.
    expect(gradeForWriting({ mistakes: 2, hintsUsed: 1, strokeCount: 2, gaveUp: false, failedStrokes: 1 })).toBe(Rating.Hard);
    expect(gradeForWriting({ mistakes: 3, hintsUsed: 1, strokeCount: 4, gaveUp: false, failedStrokes: 1 })).toBe(Rating.Hard);
    expect(gradeForWriting({ mistakes: 3, hintsUsed: 0, strokeCount: 4, gaveUp: false, failedStrokes: 3 })).toBe(Rating.Again);
  });
});

describe('choicesFrom', () => {
  const pool = ['water', 'fire', 'tree', 'gold', 'earth', 'water', 'Fire'];
  const key = (s: string) => s.toLowerCase();

  it('returns n distinct options including the correct one', () => {
    for (let seed = 0; seed < 20; seed++) {
      const options = choicesFrom('water', pool, 4, key, seededRandom(seed));
      expect(options).toHaveLength(4);
      expect(options).toContain('water');
      expect(new Set(options.map(key)).size).toBe(4);
    }
  });

  it('returns fewer options when the pool runs out', () => {
    expect(choicesFrom('water', ['water', 'fire', 'FIRE'], 4, key).map(key).sort()).toEqual(['fire', 'water']);
    expect(choicesFrom('water', [], 4, key)).toEqual(['water']);
  });

  it('is reproducible with a seeded random and puts the answer in varying places', () => {
    const a = choicesFrom('water', pool, 4, key, seededRandom('card-1'));
    const b = choicesFrom('water', pool, 4, key, seededRandom('card-1'));
    expect(a).toEqual(b);
    const positions = new Set(
      Array.from({ length: 40 }, (_, seed) => choicesFrom('water', pool, 4, key, seededRandom(seed)).indexOf('water')),
    );
    expect(positions.size).toBe(4);
  });
});
