// @vitest-environment node
// Regression checks for content/kana-examples.json, the word on each kana's
// learn card (QA: most kana had no example, and き/じ showed a yōon word).
// The curriculum checks need public/data (npm run build:data) and skip without it.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isKanji } from '../src/lib/ruby.ts';
import type { KanaExamplesFile } from '../src/lib/data.ts';
import type { Curriculum, WordEntry } from '../src/lib/types.ts';
import { checkContent, detectContentKind, hasOwnKana, itemKanji, kanaCourse, mergeContent, readingMismatches } from './lib/content.ts';
import { buildKanaTable } from './lib/kana.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const built = existsSync(`${ROOT}public/data/curriculum.json`) && existsSync(`${ROOT}public/data/words.json`);

const examples = read<KanaExamplesFile>('content/kana-examples.json');
const course = kanaCourse();
const taughtKana = buildKanaTable().filter((k) => k.kind !== 'yoon');

/** Kana (or yōon) in `word` that the course teaches after `char`, or never. Long-vowel marks and small っ are not kana units. */
function taughtLater(word: string, char: string): string[] {
  const order = course.get(char)!.order;
  const chars = [...word];
  const later: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    let unit = chars[i];
    if (i + 1 < chars.length && course.has(unit + chars[i + 1])) unit += chars[++i];
    if (/[ー・ 　っッ]/.test(unit)) continue;
    const entry = course.get(unit);
    if (!entry || entry.order > order) later.push(unit);
  }
  return later;
}

describe('content/kana-examples.json', () => {
  it('passes the shared content validator with no errors or warnings', () => {
    const report = checkContent('kana-examples', examples);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('has one example for every basic, dakuten and handakuten kana of both scripts, in teaching order', () => {
    expect(taughtKana).toHaveLength(142);
    expect(Object.keys(examples)).toEqual(taughtKana.map((k) => k.char));
  });

  it('uses each kana with its own sound, not only inside a yōon', () => {
    for (const [char, ex] of Object.entries(examples)) expect(hasOwnKana(ex.kana, char), `${char}: ${ex.kana}`).toBe(true);
    expect(examples['き'].kana).not.toMatch(/き[ゃゅょ]/);
    expect(examples['じ'].kana).not.toMatch(/じ[ゃゅょ]/);
  });

  it('writes hiragana examples in hiragana and katakana examples (loanwords) in katakana', () => {
    for (const k of taughtKana) {
      const word = examples[k.char].kana;
      expect(word, k.char).toMatch(k.script === 'hiragana' ? /^[ぁ-ゖー ]+$/ : /^[ァ-ヺー]+$/);
    }
  });

  it('keeps examples short, with a short English gloss and a kanji spelling only when it has kanji', () => {
    for (const [char, ex] of Object.entries(examples)) {
      expect([...ex.kana].length, `${char}: ${ex.kana}`).toBeLessThanOrEqual(6);
      expect(ex.en.length, `${char}: ${ex.en}`).toBeLessThanOrEqual(32);
      if (ex.written !== undefined) expect([...ex.written].some(isKanji), `${char}: ${ex.written}`).toBe(true);
    }
  });

  it('only uses kana taught by then, except where no common word exists', () => {
    const later = Object.fromEntries(
      Object.entries(examples)
        .map(([char, ex]) => [char, taughtLater(ex.kana, char)] as const)
        .filter(([, kana]) => kana.length > 0),
    );
    // The first kana of each script cannot spell a word by themselves, and
    // シ, セ and ザ have no common word made only of earlier kana.
    expect(later).toEqual({
      あ: ['い'],
      ア: ['イ', 'ス'],
      イ: ['ン', 'ク'],
      ウ: ['ル'],
      エ: ['コ', 'ン'],
      オ: ['ル'],
      シ: ['タ'],
      セ: ['タ'],
      ザ: ['ピ'],
    });
  });
});

describe('kana-examples validation', () => {
  it('rejects unknown keys, kanji, yōon-only and wrong-script examples', () => {
    const { errors } = checkContent('kana-examples', {
      き: { kana: 'きゅう', en: 'nine' },
      じ: { kana: 'じゅう', en: 'ten' },
      ア: { kana: 'あい', en: 'love' },
      け: { kana: '池', en: 'pond' },
      きゃ: { kana: 'きゃく', en: 'guest' },
      ン: { kana: 'ワイン' },
    });
    expect(errors).toEqual([
      '"き": "きゅう" must use き on its own, not only in a yōon',
      '"じ": "じゅう" must use じ on its own, not only in a yōon',
      '"ア": "あい" must use ア on its own',
      '"け": "kana" must be kana only, got "池"',
      '"きゃ": keys must be basic, dakuten or handakuten kana from kana.json',
      '"ン": "en" must be a non-empty string',
    ]);
    expect(checkContent('kana-examples', { ア: { kana: 'アあい', en: 'x' } }).errors).toEqual([
      '"ア": "アあい" must be written in katakana, like ア',
    ]);
    expect(checkContent('kana-examples', []).errors).toEqual(['file: must be an object mapping a kana to its example word']);
  });

  it('warns about kana without an example', () => {
    const { warnings } = checkContent('kana-examples', { け: { kana: 'いけ', en: 'pond' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^file: no example word for 141 kana: あいうえおかきくこ/);
  });

  it('is detected by name or shape and merged as one map', () => {
    expect(detectContentKind('content/kana-examples.json', {})).toBe('kana-examples');
    expect(detectContentKind('draft.json', { け: { kana: 'いけ', en: 'pond' } })).toBe('kana-examples');
    expect(detectContentKind('draft.json', { 水: 'Water drips down.' })).toBe('mnemonics');
    const merged = mergeContent('kana-examples', [
      { file: 'a.json', data: { け: { kana: 'いけ', en: 'pond' } } },
      { file: 'b.json', data: { ア: { kana: 'アイス', en: 'ice cream' } } },
    ]);
    expect(merged.data).toEqual({ け: { kana: 'いけ', en: 'pond' }, ア: { kana: 'アイス', en: 'ice cream' } });
    expect(merged.errors).toEqual([]);
  });

  it('compares a kanji spelling with its kana reading', () => {
    const [item] = checkContent('kana-examples', { け: { kana: 'いけ', written: '池', en: 'pond' } }).items;
    expect(readingMismatches(item, new Map([['池', ['いけ']]]))).toEqual([]);
    expect(readingMismatches(item, new Map([['池', ['ち']]]))).toEqual([
      { path: '"け".written', written: '池', reading: 'いけ', expected: ['ち'] },
    ]);
  });
});

describe.skipIf(!built)('content/kana-examples.json against the curriculum', () => {
  it('spells words with kanji the curriculum teaches', () => {
    const taught = new Set(read<Curriculum>('public/data/curriculum.json').units.map((u) => u.char));
    for (const item of checkContent('kana-examples', examples).items) {
      expect(itemKanji(item).filter((k) => !taught.has(k)), item.id).toEqual([]);
    }
  });

  it('reads kanji spellings as words.json does', () => {
    const byWritten = new Map<string, string[]>();
    for (const w of read<WordEntry[]>('public/data/words.json')) {
      byWritten.set(w.written, [...(byWritten.get(w.written) ?? []), w.kana]);
    }
    const mismatches = checkContent('kana-examples', examples).items.flatMap((item) => readingMismatches(item, byWritten));
    expect(mismatches).toEqual([]);
  });

  it('ships the file unchanged in public/data', () => {
    expect(read<KanaExamplesFile>('public/data/content/kana-examples.json')).toEqual(examples);
  });
});
