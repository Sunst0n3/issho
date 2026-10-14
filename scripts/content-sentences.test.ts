// @vitest-environment node
// Regression checks for content/sentences/*.json, from the reviews of each
// file. Every file covers a band of the curriculum: its kanji sentences unlock
// (their last kanji is taught) after the previous band and no later than the
// unit teaching the band's last kanji, sorted by unlock. Kana-only sentences
// (ids s-k…) can be read from the start. The curriculum checks need public/data
// (npm run build:data) and skip without it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kanjiIn, parseRuby, rubyToKana, rubyToPlain } from '../src/lib/ruby.ts';
import type { Curriculum, GrammarPoint, KanjiEntry, SentenceEntry, WordEntry } from '../src/lib/types.ts';
import { checkContent, lateGrammarTags, readingMismatches } from './lib/content.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const built = existsSync(`${ROOT}public/data/curriculum.json`) && existsSync(`${ROOT}public/data/words.json`);

/** Each band ends at the unit teaching this kanji (units 119, 279, 499 and 899 when the files were written). */
const BANDS = [
  { file: 's1', last: '車' },
  { file: 's2', last: '住' },
  { file: 's3', last: '勝' },
  { file: 's4', last: '宣' },
];

const files = readdirSync(`${ROOT}content/sentences`).filter((f) => f.endsWith('.json'));
const byFile = new Map(BANDS.map(({ file }) => [file, read<SentenceEntry[]>(`content/sentences/${file}.json`)]));
const all = [...byFile.values()].flat();
const grammar = read<GrammarPoint[]>('content/grammar.json');
const isKanaSentence = (s: SentenceEntry) => s.id.startsWith('s-k');

const plain = (jp: string) => rubyToPlain(jp).replace(/[。、！？「」!?\s]/g, '');
/** The sentence as heard: readings applied, katakana folded into hiragana. */
const spoken = (jp: string) =>
  rubyToKana(jp)
    .replace(/[。、！？「」!?\s]/g, '')
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));

describe('content/sentences/*.json', () => {
  it('has one file per band', () => {
    expect(files.sort()).toEqual(BANDS.map((b) => `${b.file}.json`));
  });

  it('validates cleanly', () => {
    for (const [file, sentences] of byFile) {
      const report = checkContent('sentences', sentences);
      expect(report.errors, file).toEqual([]);
      expect(report.warnings, file).toEqual([]);
    }
  });

  it('numbers ids in file order: s-<file>-001…, kana-only sentences s-k001…', () => {
    for (const [file, sentences] of byFile) {
      const pad = (n: number) => String(n + 1).padStart(3, '0');
      expect(sentences.filter((s) => !isKanaSentence(s)).map((s) => s.id)).toEqual(
        sentences.filter((s) => !isKanaSentence(s)).map((_, i) => `s-${file}-${pad(i)}`),
      );
      expect(sentences.filter(isKanaSentence).map((s) => s.id)).toEqual(
        sentences.filter(isKanaSentence).map((_, i) => `s-k${pad(i)}`),
      );
    }
  });

  it('never repeats an id, a sentence (as written or as heard) or a translation', () => {
    const keys: [string, (s: SentenceEntry) => string][] = [
      ['id', (s) => s.id],
      ['Japanese', (s) => plain(s.jp)],
      ['spoken form', (s) => spoken(s.jp)],
      ['English', (s) => s.en.toLowerCase()],
    ];
    for (const [what, key] of keys) {
      const seen = new Map<string, string>();
      const repeats: string[] = [];
      for (const s of all) {
        const k = key(s);
        if (seen.has(k)) repeats.push(`${s.id} repeats the ${what} of ${seen.get(k)}`);
        seen.set(k, s.id);
      }
      expect(repeats).toEqual([]);
    }
  });

  it('tags only known grammar points; kana-only sentences only phase-1 ones', () => {
    const phase = new Map(grammar.map((g) => [g.id, g.phase]));
    for (const s of all) {
      for (const g of s.grammar ?? []) {
        expect(phase.has(g), `${s.id}: ${g}`).toBe(true);
        if (isKanaSentence(s)) expect(phase.get(g), `${s.id}: ${g}`).toBe(1);
      }
      if (isKanaSentence(s)) expect(kanjiIn(s.jp), s.id).toEqual([]);
    }
  });

  it('uses context-dependent readings correctly', () => {
    const expected: Record<string, string> = {
      今日: 'きょう', 大人: 'おとな', 一人: 'ひとり', 二人: 'ふたり', 一日: 'いちにち', 一日中: 'いちにちじゅう',
      二十日: 'はつか', 八日: 'ようか', 三日: 'みっか', 四月: 'しがつ', 七時: 'しちじ', 九時: 'くじ',
      三分: 'さんぷん', 一斤: 'いっきん', 一寸: 'いっすん', 上手: 'じょうず', 半分: 'はんぶん', 年玉: 'としだま',
      午前中: 'ごぜんちゅう', 日本刀: 'にほんとう', 東口: 'ひがしぐち', 北口: 'きたぐち', 夕日: 'ゆうひ',
    };
    const wrong: string[] = [];
    for (const s of all) {
      for (const seg of parseRuby(s.jp)) {
        if (seg.reading && seg.text in expected && seg.reading !== expected[seg.text]) {
          wrong.push(`${s.id}: {${seg.text}|${seg.reading}} should be ${expected[seg.text]}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe.skipIf(!built)('content/sentences/*.json against the curriculum', () => {
  const { units } = built ? read<Curriculum>('public/data/curriculum.json') : { units: [] };
  const unitOf = new Map(units.map((u) => [u.char, u]));
  const unlock = (s: SentenceEntry) => Math.max(-1, ...kanjiIn(s.jp).map((k) => unitOf.get(k)?.index ?? Infinity));
  const bandRange = (i: number) => ({
    from: i === 0 ? 0 : unitOf.get(BANDS[i - 1].last)!.index + 1,
    to: unitOf.get(BANDS[i].last)!.index,
  });
  const grammarPhase = new Map(grammar.map((g) => [g.id, g.phase]));

  it('unlocks every kanji sentence inside its band, sorted by unlock', () => {
    BANDS.forEach(({ file }, i) => {
      const { from, to } = bandRange(i);
      let last = -1;
      for (const s of byFile.get(file)!.filter((x) => !isKanaSentence(x))) {
        const u = unlock(s);
        expect(u >= from && u <= to, `${s.id} unlocks at ${u}, outside ${from}–${to}`).toBe(true);
        expect(u, `${s.id} is out of unlock order`).toBeGreaterThanOrEqual(last);
        last = u;
      }
    });
  });

  it('tags no grammar from a phase after its band', () => {
    BANDS.forEach(({ file }, i) => {
      const { from, to } = bandRange(i);
      const bandPhase = Math.max(...units.filter((u) => u.index >= from && u.index <= to).map((u) => u.phase));
      for (const s of byFile.get(file)!) {
        for (const g of s.grammar ?? []) expect(grammarPhase.get(g), `${s.id}: ${g}`).toBeLessThanOrEqual(bandPhase);
      }
    });
  });

  it('has no sentence that uses grammar before it is taught', () => {
    expect(lateGrammarTags(all, units, grammarPhase).map((l) => `${l.id} ${l.grammar}`)).toEqual([]);
  });

  it('reads whole words as words.json does', () => {
    const byWritten = new Map<string, string[]>();
    for (const w of read<WordEntry[]>('public/data/words.json')) {
      byWritten.set(w.written, [...(byWritten.get(w.written) ?? []), w.kana]);
    }
    const items = checkContent('sentences', all).items;
    expect(items.flatMap((item) => readingMismatches(item, byWritten))).toEqual([]);
  });

  it('covers every s2 kanji except the six with no usable everyday word', () => {
    const kanji = read<Record<string, KanjiEntry>>('public/data/kanji.json');
    const { from, to } = bandRange(BANDS.findIndex((b) => b.file === 's2'));
    const used = new Set(byFile.get('s2')!.flatMap((s) => kanjiIn(s.jp)));
    const missing = units.filter((u) => u.index >= from && u.index <= to && u.char in kanji && !used.has(u.char));
    expect(missing.map((u) => u.char).sort()).toEqual([...'又巾是予介吏'].sort());
  });
});

/** Constructions a phase-2 learner has not met (phase-3 points, or none in grammar.json). */
const BEYOND_PHASE_2: [string, RegExp][] = [
  ['ta-koto-ga-aru', /[ただ]ことが/],
  ['to-omou', /と(おも|思)/],
  ['kara-because', /[いだ]から、/],
  ['toki-when', /\{時\|とき\}|とき、/],
  ['yori-hou', /より/],
  ['casual-past', /(?<!まし|でし)た[。？！]|んだ[。？！]/],
  ['-tara conditional', /[ただ]ら、/],
  ['-te shimau', /[てで]しま/],
  ['classical negative -zu', /[かさたなまらがばわ]ず[^っ]/],
];

const bigrams = (s: string) => {
  const chars = [...s];
  return new Set(chars.slice(1).map((ch, i) => chars[i] + ch));
};
const englishWords = (en: string) => new Set(en.toLowerCase().match(/[a-z']+/g) ?? []);
const overlap = <T,>(a: Set<T>, b: Set<T>) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.max(1, Math.min(a.size, b.size));
};
const dice = <T,>(a: Set<T>, b: Set<T>) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
};
/** Same structure (Japanese bigrams) and the same message (English words). */
const sayTheSame = (a: SentenceEntry, b: SentenceEntry) =>
  overlap(bigrams(plain(a.jp)), bigrams(plain(b.jp))) >= 0.5 && overlap(englishWords(a.en), englishWords(b.en)) >= 0.4;

describe('sentence wording', () => {
  it('uses only grammar a phase-2 learner has been taught in s1 and s2', () => {
    const problems: string[] = [];
    for (const s of [...byFile.get('s1')!, ...byFile.get('s2')!]) {
      const text = rubyToPlain(s.jp);
      for (const [name, re] of BEYOND_PHASE_2) if (re.test(s.jp) || re.test(text)) problems.push(`${s.id} uses ${name}: ${text}`);
    }
    expect(problems).toEqual([]);
  });

  it('catches the near-duplicate pairs found in review', () => {
    const pairs: [string, string, string, string][] = [
      ['{兄|あに}は{東京|とうきょう}の{銀行|ぎんこう}で{働|はたら}いています。', 'My older brother works at a bank in Tokyo.',
        '{姉|あね}は{事務所|じむしょ}で{働|はたら}いています。', 'My older sister works in an office.'],
      ['{義理|ぎり}の{母|はは}は{料理|りょうり}がとても{上手|じょうず}です。', 'My mother-in-law is a really good cook.',
        '{夫|おっと}は{料理|りょうり}が{得意|とくい}です。', 'My husband is good at cooking.'],
      ['{友|とも}だちは{大学|だいがく}で{研究|けんきゅう}をしています。', 'My friend does research at a university.',
        '{弟|おとうと}は{大学|だいがく}で{経済|けいざい}を{勉強|べんきょう}しています。', 'My younger brother is studying economics at university.'],
    ];
    for (const [ajp, aen, bjp, ben] of pairs) {
      expect(sayTheSame({ id: 'a', jp: ajp, en: aen }, { id: 'b', jp: bjp, en: ben }), `${aen} / ${ben}`).toBe(true);
    }
  });

  // s1 drills beginner patterns on purpose (あれはわたしのうちです / …ともだちです), so it is exempt.
  it('has no near-duplicates within s2, s3 or s4', () => {
    const problems: string[] = [];
    for (const file of ['s2', 's3', 's4']) {
      const sentences = byFile.get(file)!;
      const shapes = sentences.map((s) => bigrams(plain(s.jp)));
      for (let i = 0; i < sentences.length; i++) {
        for (let j = i + 1; j < sentences.length; j++) {
          const [a, b] = [sentences[i], sentences[j]];
          if (dice(shapes[i], shapes[j]) >= 0.7) problems.push(`${a.id} and ${b.id} are worded almost alike`);
          else if (file !== 's2' && sayTheSame(a, b)) problems.push(`${a.id} and ${b.id} say nearly the same thing`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the review fixes', () => {
    const texts = (file: string) => byFile.get(file)!.map((s) => plain(s.jp));
    // s2 proposed going to see the cherry blossoms twice.
    const hanami = byFile.get('s2')!.filter((s) => s.jp.includes('{花見|はなみ}') && /ましょう|ませんか/.test(s.jp));
    expect(hanami.length).toBeLessThanOrEqual(1);
    // 問題を与える is translationese (問題を出す); "turn right" is 角を右へ曲がる, not 行く.
    expect(texts('s3').filter((t) => t.includes('問題を与え') || /角を(右|左)[へに]行/.test(t))).toEqual([]);
    // Repeats of s1-064 (waiting at a station exit) and s2-068 (writing in Japanese every day).
    expect(texts('s3').filter((t) => /口で待って/.test(t) || /日本語で(日記|作文)を書いて/.test(t))).toEqual([]);
  });
});
