// Tokenizes ruby text ('{昨日|きのう}の{晩|ばん}ご{飯|はん}…') into words and links each one to a
// core word (content/core-words.json) or, failing that, a JMdict entry (public/data/words.json).
//
//   const tokens = await tokenizeRuby('{毎日|まいにち}{日本語|にほんご}を{勉強|べんきょう}しています。');
//
// How it works:
// - Ruby markup is stripped; '／' phrase marks and whitespace split the text into chunks that
//   kuromoji (IPADIC) tokenizes one by one (a phrase break is always a word break, which helps
//   kana-only text a lot). The author's ruby readings replace kuromoji's.
// - kuromoji is unreliable on all-hiragana text. It breaks it at small kana (ごしゅじん →
//   ご/し/ゅじんはせんせいです): such breaks are repaired with the longest core/JMdict kana word
//   over the break, or a kana number (ろっぴゃくえん → 六/百/円), and the rest is tokenized
//   again; kana tokens that spell a number with a counter (くじ, さんじ) are split. Kana text is
//   also cut at the core words and numbers it spells (やまださんはにほんごのせんせいです →
//   … にほんご | の | せんせい …), and that reading is used when it explains the text better
//   (fewer non-core words, stray kana and misplaced particles).
// - Words are matched longest-first: a run of tokens that spells a core word becomes one token
//   (食べ+放題 → 食べ放題, 勉強+し → 勉強する, お+願い+し+ます → お願いします, まい+あ+さ →
//   まいあさ). A single token matches by written form or kana; the author's reading picks
//   between homographs (人 ひと/にん/じん, 一日 いちにち/ついたち, 行っ → 行く not 行う).
//   A core word that runs across a '／' mark (おなかが／すいた → お腹がすく) comes out as one
//   token per phrase, all with the word's ref; a JMdict run never crosses one. Either way each
//   phrase holds exactly its own tokens.
//   Fallbacks: お/ご added or dropped, nouns as する-verbs, ない → ある, よい → いい, なん → 何,
//   potential/passive/causative verbs → the base verb (読める → 読む), masu-stem nouns → the
//   verb (遊び → 遊ぶ), compounds split into core words (もう少し → もう + 少し), and words
//   that only occur inside a core expression (もう一度 → もう一度お願いします).
// - kind: particles, auxiliaries (ます/た/ない/です/たい…), grammatical helpers (ている's いる,
//   nominal の/こと, そう/よう stems, passive/causative endings, かもしれない's しれ, plural
//   たち), the お/ご prefix and numbers written in digits are 'function'; symbols are 'punct';
//   everything else is 'content'.
// - proper: a person or place name that is not a core word (kuromoji's 固有名詞 人名/地域, or
//   a word followed by さん/ちゃん/くん/さま). Coverage does not count these.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpadicFeatures, Tokenizer } from 'kuromoji';
import { parseRuby } from '../../src/lib/ruby.ts';
import type { RubyText } from '../../src/lib/types.ts';

export type TokenKind = 'content' | 'function' | 'punct';
export type TokenRef = `core:${string}` | `word:${string}`;

export interface RubyToken {
  /** The word as written, without ruby markup or phrase marks: '食べ', '晩ご飯'. */
  surface: string;
  /** Reading in hiragana, from the author's ruby where the text has it. */
  reading: string;
  /** Dictionary form (kuromoji's basic_form); for merged or repaired words, the headword. */
  lemma: string;
  /** kuromoji part of speech: 名詞, 動詞, 形容詞, 助詞, 助動詞, 記号 … */
  pos: string;
  /** kuromoji's first POS detail when it has one: サ変接続, 非自立, 固有名詞 … */
  posDetail?: string;
  /** 'core:cw-0123' for a core word, else 'word:<JMdict id>', else absent. */
  ref?: TokenRef;
  kind: TokenKind;
  /** A name (person or place) that is not a core word; coverage leaves it out. */
  proper?: boolean;
  /** 0-based index of the '／' phrase the token starts in. */
  phrase: number;
}

/** The fields of a content/core-words.json entry the tokenizer uses. */
export interface CoreWordLite {
  id: string;
  order: number;
  kana: string;
  written?: string;
  pos: string;
  /** Its JMdict entry: a JMdict match on that entry is this core word. */
  jmdict?: string;
}

/** The fields of a public/data/words.json entry the tokenizer uses. */
export interface JmdictLite {
  id: string;
  written: string;
  kana: string;
  pos?: string[];
  freqRank?: number;
}

export interface RubyTokenizer {
  tokenize(text: RubyText): RubyToken[];
  /** Core words by id ('cw-0123'). */
  readonly core: ReadonlyMap<string, CoreWordLite>;
  /** False when public/data/words.json is missing (npm run build:data); no 'word:' refs then. */
  readonly hasJmdict: boolean;
}

export interface TokenizerOptions {
  core?: CoreWordLite[];
  /** JMdict entries for the fallback; null skips it. */
  words?: JmdictLite[] | null;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------------------------
// Kana helpers

const KANA_ONLY_RE = /^[ぁ-ゖァ-ヺーゝゞヽヾ]+$/u;
const HIRAGANA_RE = /^[ぁ-ゖーゝゞ]+$/u;
const SMALL_START_RE = /^[ぁぃぅぇぉゃゅょゎゕゖっー]/u;
const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/u;
const PUNCT_RE = /^[\p{P}\p{S}]+$/u;
const DIGITS_RE = /^[0-9０-９.,，．]+$/u;
const LATIN_RE = /^[A-Za-zＡ-Ｚａ-ｚ'’-]+$/u;
const BREAK_RE = /[／\s]/u;

export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function isKanaWord(s: string): boolean {
  return KANA_ONLY_RE.test(s);
}

function hasKanji(s: string): boolean {
  return KANJI_RE.test(s);
}

/** Reading of a dictionary form, from the reading of a (possibly conjugated) surface. */
function lemmaReading(surface: string, lemma: string, reading: string): string {
  if (lemma === surface) return reading;
  if (isKanaWord(lemma)) return toHiragana(lemma);
  if (lemma === '来る') return 'くる';
  let p = 0;
  while (p < surface.length && p < lemma.length && surface[p] === lemma[p]) p++;
  const sTail = surface.slice(p);
  const lTail = lemma.slice(p);
  if ((sTail && !isKanaWord(sTail)) || (lTail && !isKanaWord(lTail))) return reading;
  const st = toHiragana(sTail);
  if (!reading.endsWith(st)) return reading;
  return reading.slice(0, reading.length - st.length) + toHiragana(lTail);
}

const I_TO_U: Record<string, string> = { い: 'う', き: 'く', ぎ: 'ぐ', し: 'す', ち: 'つ', に: 'ぬ', び: 'ぶ', み: 'む', り: 'る' };
const E_TO_U: Record<string, string> = { え: 'う', け: 'く', げ: 'ぐ', せ: 'す', て: 'つ', ね: 'ぬ', べ: 'ぶ', め: 'む', れ: 'る' };
const A_TO_U: Record<string, string> = { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' };

/** Base verbs a potential, passive or causative verb may come from: 読める → 読む. */
function baseVerbs(lemma: string): string[] {
  const out: string[] = [];
  let m = /^(.+)(させる|られる)$/u.exec(lemma);
  if (m) out.push(m[1] + 'る');
  m = /^(.+)([わかがさたなばまら])(せる|れる)$/u.exec(lemma);
  if (m) out.push(m[1] + A_TO_U[m[2]]);
  m = /^(.+)([えけげせてねべめれ])る$/u.exec(lemma);
  if (m) out.push(m[1] + E_TO_U[m[2]]);
  return out;
}

type VerbClass = 'verb-ru' | 'verb-u' | 'verb-irr';

/** The core-word verb class of a kuromoji conjugation type (五段・ラ行 → verb-u). */
function verbClass(ctype: string): VerbClass | undefined {
  if (ctype.startsWith('五段')) return 'verb-u';
  if (ctype.startsWith('一段')) return 'verb-ru';
  if (ctype.startsWith('カ変') || ctype.startsWith('サ変')) return 'verb-irr';
  return undefined;
}

/**
 * Dictionary forms (with their verb class) a kana verb form may have, by kuromoji's conjugated
 * form: おき (連用形) → おきる/おく, かい (連用形) → かう, かい (連用タ接続, かいて) → かく/かぐ,
 * まっ → まう/まつ/まる, いら (未然形, いらない) → いる (五段: 要る, not 居る).
 */
function kanaVerbs(stem: string, cform: string): { form: string; cls: VerbClass }[] {
  const last = stem.slice(-1);
  const head = stem.slice(0, -1);
  if (!head) return [];
  const godan = (...ends: string[]) => ends.map((e) => ({ form: head + e, cls: 'verb-u' as const }));
  const ichidan = { form: stem + 'る', cls: 'verb-ru' as const };
  if (cform === '連用タ接続') {
    if (last === 'っ') return godan('う', 'つ', 'る');
    if (last === 'ん') return godan('む', 'ぶ', 'ぬ');
    if (last === 'い') return godan('く', 'ぐ');
    return [ichidan];
  }
  if (cform === '連用形') return I_TO_U[last] ? [ichidan, ...godan(I_TO_U[last])] : [ichidan];
  if (cform.startsWith('未然')) return A_TO_U[last] ? [ichidan, ...godan(A_TO_U[last])] : [ichidan];
  return [];
}

const VOICED: Record<string, string> = {
  か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ',
  た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ',
};
const SEMIVOICED: Record<string, string> = { は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ' };

/** A word's kana with its first sound voiced or half-voiced, as after a number (分 ふん/ぷん, 本 ほん/ぼん/ぽん). */
function soundVariants(kana: string): string[] {
  const out = [kana];
  for (const map of [VOICED, SEMIVOICED]) if (map[kana[0]]) out.push(map[kana[0]] + kana.slice(1));
  return out;
}

/** Verbs a masu-stem noun may come from: 遊び → 遊ぶ, 考え → 考える. */
function stemVerbs(noun: string): string[] {
  const last = noun.slice(-1);
  const out: string[] = [];
  if (I_TO_U[last] && noun.length > 1) out.push(noun.slice(0, -1) + I_TO_U[last]);
  if ((I_TO_U[last] || E_TO_U[last]) && noun.length > 1) out.push(noun + 'る');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Kana numbers: いち/いっ, に, さん … with 十/百/千/万 and common counters

const NUMBER_PIECES: [kana: string, kanji: string, type: 'digit' | 'power' | 'counter'][] = [
  ['いち', '一', 'digit'], ['いっ', '一', 'digit'], ['に', '二', 'digit'], ['さん', '三', 'digit'],
  ['よん', '四', 'digit'], ['よ', '四', 'digit'], ['ご', '五', 'digit'], ['ろく', '六', 'digit'],
  ['ろっ', '六', 'digit'], ['なな', '七', 'digit'], ['しち', '七', 'digit'], ['はち', '八', 'digit'],
  ['はっ', '八', 'digit'], ['きゅう', '九', 'digit'], ['く', '九', 'digit'],
  ['じゅう', '十', 'power'], ['じゅっ', '十', 'power'], ['じっ', '十', 'power'], ['ひゃく', '百', 'power'],
  ['びゃく', '百', 'power'], ['ぴゃく', '百', 'power'], ['せん', '千', 'power'], ['ぜん', '千', 'power'],
  ['まん', '万', 'power'],
  ['えん', '円', 'counter'], ['じかん', '時間', 'counter'], ['じ', '時', 'counter'], ['ふん', '分', 'counter'],
  ['ぷん', '分', 'counter'], ['はん', '半', 'counter'], ['にん', '人', 'counter'], ['がつ', '月', 'counter'],
  ['にち', '日', 'counter'], ['さい', '歳', 'counter'], ['ねん', '年', 'counter'], ['かい', '回', 'counter'],
  ['まい', '枚', 'counter'], ['ほん', '本', 'counter'], ['ぼん', '本', 'counter'], ['ぽん', '本', 'counter'],
  ['こ', '個', 'counter'],
];
NUMBER_PIECES.sort((a, b) => b[0].length - a[0].length);

interface NumberPiece {
  kana: string;
  kanji: string;
  type: 'digit' | 'power' | 'counter';
}

/** A kana number starting at `from` (digit or power first, then anything), or undefined. */
function parseNumber(text: string, from: number): NumberPiece[] | undefined {
  const pieces: NumberPiece[] = [];
  let p = from;
  while (p < text.length) {
    const hit = NUMBER_PIECES.find(([k]) => text.startsWith(k, p));
    // Two digits never follow each other (ごご is 午後, not 五五).
    if (!hit || (hit[2] === 'digit' && pieces.at(-1)?.type === 'digit')) break;
    pieces.push({ kana: hit[0], kanji: hit[1], type: hit[2] });
    p += hit[0].length;
  }
  if (pieces.length < 2 || pieces[0].type === 'counter') return undefined;
  if (!pieces.some((x) => x.type !== 'digit')) return undefined;
  // A counter ends the number: さんじはん = 三/時/半, but nothing after a later counter.
  const firstCounter = pieces.findIndex((x) => x.type === 'counter');
  const end = firstCounter < 0 ? pieces.length : pieces.findIndex((x, i) => i > firstCounter && x.type !== 'counter');
  return end < 0 ? pieces : pieces.slice(0, end);
}

// ---------------------------------------------------------------------------------------------
// Lexicon: core words first, JMdict as the fallback

const POS_COMPAT: Record<string, string[]> = {
  名詞: ['noun', 'pronoun', 'number', 'counter', 'suffix', 'adj-na', 'adverb', 'expression', 'demonstrative'],
  動詞: ['verb-ru', 'verb-u', 'verb-irr', 'expression'],
  形容詞: ['adj-i', 'expression'],
  副詞: ['adverb', 'expression', 'adj-na', 'demonstrative'],
  連体詞: ['demonstrative', 'adj-na', 'pronoun', 'expression'],
  感動詞: ['interjection', 'expression'],
  フィラー: ['interjection', 'expression'],
  接続詞: ['conjunction', 'expression'],
  助詞: ['particle-phrase', 'suffix', 'conjunction'],
  接頭詞: ['prefix'],
};

/** IPADIC part of speech for a core word's pos, where it has a clear one. */
const CORE_POS: Record<string, [string, string]> = {
  noun: ['名詞', '一般'],
  pronoun: ['名詞', '代名詞'],
  number: ['名詞', '数'],
  counter: ['名詞', '接尾'],
  suffix: ['名詞', '接尾'],
  'adj-na': ['名詞', '形容動詞語幹'],
  'verb-ru': ['動詞', '自立'],
  'verb-u': ['動詞', '自立'],
  'verb-irr': ['動詞', '自立'],
  'adj-i': ['形容詞', '自立'],
  adverb: ['副詞', '一般'],
  interjection: ['感動詞', '*'],
  conjunction: ['接続詞', '*'],
  prefix: ['接頭詞', '名詞接続'],
  'particle-phrase': ['助詞', '副助詞'],
  demonstrative: ['名詞', '代名詞'],
};

/** IPADIC part of speech for a JMdict entry's pos codes. */
function jmdictPos(codes: string[] = []): [string, string] {
  if (codes.some((c) => /^(v1|v5|vk|vz|vs-i|vs-s|vs-c)/u.test(c))) return ['動詞', '自立'];
  if (codes.some((c) => c === 'adj-i' || c === 'adj-ix')) return ['形容詞', '自立'];
  if (codes.includes('adv') || codes.includes('adv-to')) return codes.includes('n') ? ['名詞', '副詞可能'] : ['副詞', '一般'];
  if (codes.includes('int')) return ['感動詞', '*'];
  if (codes.includes('conj')) return ['接続詞', '*'];
  if (codes.includes('prt')) return ['助詞', '副助詞'];
  if (codes.includes('aux-v')) return ['助動詞', '*'];
  if (codes.includes('adj-pn')) return ['連体詞', '*'];
  if (codes.includes('pref') || codes.includes('n-pref')) return ['接頭詞', '名詞接続'];
  if (codes.includes('suf') || codes.includes('n-suf') || codes.includes('ctr')) return ['名詞', '接尾'];
  if (codes.includes('num')) return ['名詞', '数'];
  if (codes.includes('vs')) return ['名詞', 'サ変接続'];
  if (codes.includes('adj-na')) return ['名詞', '形容動詞語幹'];
  return ['名詞', '一般'];
}

/** Dictionary forms kuromoji gives that the core list teaches under another headword. */
const ALIASES: Record<string, string[]> = {
  ない: ['ある'],
  無い: ['ある'],
  よい: ['いい'],
  良い: ['いい'],
  善い: ['いい'],
  なん: ['何'],
};

const VERB_POS = new Set(['verb-ru', 'verb-u', 'verb-irr']);
const NAME_SUFFIXES = new Set(['さん', 'ちゃん', 'くん', '君', 'さま', '様']);
const FUNCTION_SUFFIXES = new Set(['たち', '達', 'ら', 'ども']);
const HONORIFIC_PREFIX_RE = /^[おご御]/u;
const PARTICLE_KANA = new Set(['は', 'が', 'を', 'に', 'で', 'と', 'も', 'へ', 'や', 'の', 'か', 'ね', 'よ']);
const TOPIC_CASE = new Set(['は', 'が', 'を', 'も']);
const LITERARY_PARTICLES = new Set(['つつ', 'ぞ', 'ども']);
const LONG_PARTICLES = ['です', 'まで', 'から', 'より', 'だけ', 'しか', 'など', 'ぐらい', 'くらい', 'ごろ'];
/** Particles that follow nouns, never verb stems: before them a kana noun beats a verb (みせは → 店). */
const NOUN_PARTICLES = new Set(['は', 'が', 'を', 'の', 'も', 'です', 'だ', 'じゃ']);

interface KanaEntry {
  lemma: string;
  pos: string;
  detail1: string;
}

interface CoreQuery {
  kpos: string;
  /** Minimum kana length for kana-only matches (windows use 3 to avoid chance spellings). */
  minKana?: number;
  onlyPos?: Set<string>;
  /** Only words whose kana is one of the given readings. */
  strict?: boolean;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function sharesKanji(a: string, b: string): boolean {
  for (const ch of a) if (hasKanji(ch) && b.includes(ch)) return true;
  return false;
}

class Lexicon {
  readonly coreById = new Map<string, CoreWordLite>();
  private readonly coreWritten = new Map<string, CoreWordLite[]>();
  private readonly coreKana = new Map<string, CoreWordLite[]>();
  private readonly jmWritten = new Map<string, JmdictLite[]>();
  private readonly jmKana = new Map<string, JmdictLite[]>();
  /** Hiragana words for repairing broken kana text. */
  readonly kanaWords = new Map<string, KanaEntry>();
  readonly verbsWithKanji: CoreWordLite[] = [];
  /** Words that occur only inside a core expression: もう一度 → もう一度お願いします. */
  readonly expressionParts = new Map<string, CoreWordLite>();
  readonly hasJmdict: boolean;
  maxKanaWord = 0;
  maxCoreKana = 0;

  constructor(core: CoreWordLite[], words: JmdictLite[] | null) {
    this.hasJmdict = !!words;
    for (const w of words ?? []) {
      if (w.written) push(this.jmWritten, w.written, w);
      const k = toHiragana(w.kana);
      push(this.jmKana, k, w);
      if (HIRAGANA_RE.test(k) && k.length >= 2 && !this.kanaWords.has(k)) {
        const [pos, detail1] = jmdictPos(w.pos);
        this.kanaWords.set(k, { lemma: k, pos, detail1 });
      }
    }
    for (const w of core) {
      this.coreById.set(w.id, w);
      if (w.written) push(this.coreWritten, w.written, w);
      const k = toHiragana(w.kana);
      push(this.coreKana, k, w);
      if (HIRAGANA_RE.test(k) && k.length >= 2) {
        const [pos, detail1] = CORE_POS[w.pos] ?? ['名詞', '一般'];
        this.kanaWords.set(k, { lemma: k, pos, detail1 });
      }
      if ((w.pos.startsWith('verb') || w.pos === 'adj-i') && w.written && hasKanji(w.written)) this.verbsWithKanji.push(w);
    }
    for (const k of this.kanaWords.keys()) this.maxKanaWord = Math.max(this.maxKanaWord, k.length);
    for (const k of this.coreKana.keys()) this.maxCoreKana = Math.max(this.maxCoreKana, k.length);
  }

  /**
   * Readings a token written `form` may have inside a ruby group: kuromoji's (`reading`), the core and
   * JMdict readings of that spelling, and the number readings (九 く/きゅう, 人 にん, 時 じ).
   */
  readingsOf(form: string, reading: string): string[] {
    const out = [reading];
    for (const w of this.coreWritten.get(form) ?? []) out.push(toHiragana(w.kana));
    for (const w of this.jmWritten.get(form) ?? []) out.push(toHiragana(w.kana));
    for (const [kana, kanji] of NUMBER_PIECES) if (kanji === form) out.push(kana);
    return [...new Set(out.filter(Boolean))];
  }

  isCoreKana(kana: string): boolean {
    return this.coreKana.has(toHiragana(kana));
  }

  /** Core words written `form` (by kana when the form is all kana), earliest first. */
  coreByForm(form: string): CoreWordLite[] {
    const list = isKanaWord(form) ? this.coreKana.get(toHiragana(form)) : this.coreWritten.get(form);
    return [...(list ?? [])].sort((a, b) => a.order - b.order);
  }

  /**
   * Best core word spelled by one of `forms` (written, or kana when the form is all kana), or,
   * for forms with kanji, read as one of `kanas` (a word the core list writes in kana, or one
   * spelled with a shared kanji: 御飯/ご飯, 分かる/分る). Ties go to a word written exactly as
   * one of `forms` (三 over さん), then one whose kana is one of `kanas`, then to the
   * kuromoji-compatible pos, then to the earliest.
   */
  core(forms: string[], kanas: string[], q: CoreQuery): CoreWordLite | undefined {
    const minKana = q.minKana ?? 1;
    const kanaSet = new Set(kanas.filter(Boolean).map(toHiragana));
    const found = new Set<CoreWordLite>();
    const kanjiForms: string[] = [];
    for (const f of forms) {
      if (!f) continue;
      if (isKanaWord(f)) {
        const k = toHiragana(f);
        if (k.length >= minKana) for (const w of this.coreKana.get(k) ?? []) found.add(w);
      } else {
        for (const w of this.coreWritten.get(f) ?? []) found.add(w);
        if (hasKanji(f)) kanjiForms.push(f);
      }
    }
    if (!found.size && kanjiForms.length) {
      for (const k of kanaSet) {
        if (k.length < minKana) continue;
        for (const w of this.coreKana.get(k) ?? []) {
          if (!w.written || kanjiForms.some((f) => sharesKanji(f, w.written!))) found.add(w);
        }
      }
    }
    let list = [...found];
    if (q.onlyPos) list = list.filter((w) => q.onlyPos!.has(w.pos));
    if (q.strict) list = list.filter((w) => kanaSet.has(toHiragana(w.kana)));
    if (!list.length) return undefined;
    const compat = POS_COMPAT[q.kpos] ?? [];
    const score = (w: CoreWordLite) =>
      (w.written && forms.includes(w.written) ? 4 : 0) + (kanaSet.has(toHiragana(w.kana)) ? 2 : 0) + (compat.includes(w.pos) ? 1 : 0);
    return list.sort((a, b) => score(b) - score(a) || a.order - b.order)[0];
  }

  /** Best JMdict entry for `forms` (kana-only forms only when allowed). */
  jmdict(forms: string[], kanas: string[], allowKana: boolean): JmdictLite | undefined {
    const kanaSet = new Set(kanas.filter(Boolean).map(toHiragana));
    const found = new Set<JmdictLite>();
    for (const f of forms) {
      if (!f) continue;
      if (isKanaWord(f)) {
        if (allowKana) for (const w of this.jmKana.get(toHiragana(f)) ?? []) found.add(w);
      } else {
        for (const w of this.jmWritten.get(f) ?? []) found.add(w);
      }
    }
    if (!found.size) return undefined;
    const score = (w: JmdictLite) => (kanaSet.has(toHiragana(w.kana)) ? 1 : 0);
    return [...found].sort((a, b) => score(b) - score(a) || (a.freqRank ?? 99) - (b.freqRank ?? 99))[0];
  }

  /** Longest core-word kana (at least 2 long) starting at `from`, with its words. */
  longestCoreKana(text: string, from: number): { len: number; words: CoreWordLite[] } | undefined {
    for (let len = Math.min(this.maxCoreKana, text.length - from); len >= 2; len--) {
      const words = this.coreKana.get(text.substr(from, len));
      if (words) return { len, words: [...words].sort((a, b) => a.order - b.order) };
    }
    return undefined;
  }

  /** Longest hiragana word in the repair lexicon starting at `from`, at least 2 long. */
  longestKana(text: string, from: number): { len: number; entry: KanaEntry } | undefined {
    for (let len = Math.min(this.maxKanaWord, text.length - from); len >= 2; len--) {
      const entry = this.kanaWords.get(text.substr(from, len));
      if (entry) return { len, entry };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Ruby text → chunks with the author's readings

interface Chunk {
  start: number; // offset in the plain text
  text: string;
  phrase: number;
}

interface PlainText {
  plain: string;
  /** For each plain character, the index of its ruby segment, or -1. */
  segAt: number[];
  segs: { start: number; end: number; reading: string }[];
  chunks: Chunk[];
}

function prepare(text: RubyText): PlainText {
  let plain = '';
  const segAt: number[] = [];
  const segs: PlainText['segs'] = [];
  for (const seg of parseRuby(text)) {
    const start = plain.length;
    plain += seg.text;
    const idx = seg.reading !== undefined ? segs.length : -1;
    if (seg.reading !== undefined) segs.push({ start, end: plain.length, reading: toHiragana(seg.reading) });
    for (let i = start; i < plain.length; i++) segAt.push(idx);
  }
  const chunks: Chunk[] = [];
  let phrase = 0;
  let cur = -1;
  for (let i = 0; i <= plain.length; i++) {
    const ch = plain[i];
    const isBreak = i === plain.length || (segAt[i] === -1 && BREAK_RE.test(ch));
    if (isBreak) {
      if (cur >= 0) chunks.push({ start: cur, text: plain.slice(cur, i), phrase });
      cur = -1;
      if (ch === '／') phrase++;
    } else if (cur < 0) {
      cur = i;
    }
  }
  return { plain, segAt, segs, chunks };
}

/** Author's reading of plain[s, e), which must not cut through a ruby segment. */
function spanReading(pt: PlainText, s: number, e: number): string {
  let out = '';
  for (let p = s; p < e; ) {
    const idx = pt.segAt[p];
    if (idx < 0) {
      out += pt.plain[p];
      p++;
    } else {
      out += pt.segs[idx].reading;
      p = pt.segs[idx].end;
    }
  }
  return toHiragana(out);
}

// ---------------------------------------------------------------------------------------------
// Raw tokens

interface Raw {
  surface: string;
  start: number;
  end: number;
  reading: string;
  lemma: string;
  lemmaKana: string;
  pos: string;
  detail1: string;
  detail2: string;
  /** kuromoji's conjugated form (連用形, 連用タ接続, 未然形 …), '' when none. */
  cform: string;
  /** kuromoji's conjugation type (五段・ラ行, 一段 …), '' when none. */
  ctype: string;
  kind: TokenKind;
  phrase: number;
  unknown: boolean;
}

function classify(pos: string, d1: string, d2: string, s: string): TokenKind {
  if (pos === '記号' || PUNCT_RE.test(s)) return 'punct';
  if (pos === '助詞' || pos === '助動詞') return 'function';
  if (pos === '接頭詞' && (s === 'お' || s === 'ご' || s === '御')) return 'function';
  if ((pos === '動詞' || pos === '形容詞') && (d1 === '非自立' || d1 === '接尾')) return 'function';
  // Dependent nouns in kana (こと, もの, の, ところ) are grammar; written with kanji (いい日, その時,
  // 大きい方) they are words the reader has to know.
  if (pos === '名詞' && (d1 === '非自立' || d1 === '特殊')) return KANJI_RE.test(s) ? 'content' : 'function';
  if (pos === '名詞' && d1 === '接尾' && (d2 === '助動詞語幹' || FUNCTION_SUFFIXES.has(s))) return 'function';
  if (DIGITS_RE.test(s) || LATIN_RE.test(s)) return 'function';
  return 'content';
}

function piece(surface: string, start: number, phrase: number, lemma: string, pos: string, detail1: string, detail2 = '*'): Raw {
  return {
    surface,
    start,
    end: start + surface.length,
    reading: toHiragana(surface),
    lemma,
    lemmaKana: '',
    pos,
    detail1,
    detail2,
    cform: '',
    ctype: '',
    kind: classify(pos, detail1, detail2, surface),
    phrase,
    unknown: false,
  };
}

function numberPieces(nums: NumberPiece[], start: number, phrase: number): Raw[] {
  const out: Raw[] = [];
  let at = start;
  for (const n of nums) {
    const [d1, d2] = n.type === 'counter' ? ['接尾', '助数詞'] : ['数', '*'];
    out.push({ ...piece(n.kana, at, phrase, n.kanji, '名詞', d1, d2), kind: 'content' });
    at += n.kana.length;
  }
  return out;
}

function kuromojiRaw(tk: Tokenizer<IpadicFeatures>, text: string, offset: number, phrase: number): Raw[] {
  const out: Raw[] = [];
  let at = offset;
  for (const f of tk.tokenize(text)) {
    const surface = f.surface_form;
    const start = at;
    at += surface.length;
    if (!surface.trim()) continue;
    out.push({
      surface,
      start,
      end: at,
      reading: f.reading && f.reading !== '*' ? toHiragana(f.reading) : toHiragana(surface),
      lemma: f.basic_form && f.basic_form !== '*' ? f.basic_form : surface,
      lemmaKana: '',
      pos: f.pos,
      detail1: f.pos_detail_1,
      detail2: f.pos_detail_2,
      cform: f.conjugated_form && f.conjugated_form !== '*' ? f.conjugated_form : '',
      ctype: f.conjugated_type && f.conjugated_type !== '*' ? f.conjugated_type : '',
      kind: classify(f.pos, f.pos_detail_1, f.pos_detail_2, surface),
      phrase,
      unknown: f.word_type === 'UNKNOWN',
    });
  }
  return out;
}

const isBroken = (t: Raw) =>
  HIRAGANA_RE.test(t.surface) && (SMALL_START_RE.test(t.surface) || (t.unknown && t.surface.length >= 2));

/** kuromoji tokens for `text` (offsets from 0), with broken kana repaired (see the header). */
function segmentText(tk: Tokenizer<IpadicFeatures>, lex: Lexicon, text: string): Raw[] {
  const out: Raw[] = [];
  let pos = 0;
  let retried = -1;
  for (let guard = 0; pos < text.length && guard < 64; guard++) {
    const rest = text.slice(pos);
    const toks = kuromojiRaw(tk, rest, pos, 0);
    const b = toks.findIndex(isBroken);
    if (b < 0) {
      out.push(...toks);
      break;
    }
    let best: { s: number; end: number; pieces: Raw[] } | undefined;
    for (let s = Math.max(0, b - 2); s <= b; s++) {
      const t = toks[s];
      if (!HIRAGANA_RE.test(t.surface) || SMALL_START_RE.test(t.surface)) continue;
      const from = t.start - pos;
      const cands: { end: number; pieces: Raw[] }[] = [];
      const word = lex.longestKana(rest, from);
      if (word) {
        const surface = rest.substr(from, word.len);
        cands.push({ end: t.start + word.len, pieces: [piece(surface, t.start, 0, word.entry.lemma, word.entry.pos, word.entry.detail1)] });
      }
      const nums = parseNumber(rest, from);
      if (nums) {
        const len = nums.reduce((n, x) => n + x.kana.length, 0);
        cands.push({ end: t.start + len, pieces: numberPieces(nums, t.start, 0) });
      }
      for (const c of cands) {
        if (c.end <= toks[b].start) continue;
        if (!best || c.end > best.end) best = { s, ...c };
      }
    }
    if (!best) {
      // No word fits: tokenize again from the broken token once (乙女ざです → ざ/です), then give up.
      const retry = b > 0 && toks[b].unknown && retried !== toks[b].start;
      out.push(...toks.slice(0, retry ? b : b + 1));
      retried = toks[b].start;
      pos = retry ? toks[b].start : toks[b].end;
      continue;
    }
    out.push(...toks.slice(0, best.s), ...best.pieces);
    pos = best.end;
  }
  // Kana tokens that are not core words but spell a number: くじ → 九/時, さんじ → 三/時, and
  // at the start or after punctuation, a run of them (に/ひゃく → 二/百, じゅう/いち/じ → 十/一/時).
  for (let k0 = out.length - 1; k0 >= 0; k0--) {
    if (k0 > 0 && out[k0 - 1].kind !== 'punct') continue;
    let run = '';
    let runEnd = -1;
    for (let k = k0; k < out.length && HIRAGANA_RE.test(out[k].surface); k++) {
      run += out[k].surface;
      const nums = parseNumber(run, 0);
      if (k > k0 && nums && nums.reduce((n, x) => n + x.kana.length, 0) === run.length && !lex.isCoreKana(run)) runEnd = k;
    }
    if (runEnd > k0) {
      const nums = parseNumber(out.slice(k0, runEnd + 1).map((t) => t.surface).join(''), 0)!;
      out.splice(k0, runEnd + 1 - k0, ...numberPieces(nums, out[k0].start, 0));
    }
  }
  for (let k = out.length - 1; k >= 0; k--) {
    const t = out[k];
    if (t.kind !== 'content' || !HIRAGANA_RE.test(t.surface) || lex.isCoreKana(t.surface)) continue;
    const nums = parseNumber(t.surface, 0);
    if (nums && nums.reduce((n, x) => n + x.kana.length, 0) === t.surface.length) {
      out.splice(k, 1, ...numberPieces(nums, t.start, 0));
    }
  }
  return out;
}

interface KanaPiece {
  start: number;
  text: string;
  /** Set when the piece is a core word or number piece read from the kana. */
  word?: { lemma: string; pos: string; detail1: string; detail2?: string };
}

/**
 * The text cut into known words and the kana between them: core words of 3+ kana that are
 * written with kanji (or of 2 where words must break: うえ → 上), and kana numbers
 * (やまださんはにほんごのせんせいです → やまださんは | にほんご (日本語) | の | せんせい (先生) |
 * です). Undefined when no word is found.
 */
function kanaPieces(lex: Lexicon, text: string): KanaPiece[] | undefined {
  const pieces: KanaPiece[] = [];
  let found = false;
  let plainFrom = 0;
  const flush = (to: number) => {
    if (to > plainFrom) pieces.push({ start: plainFrom, text: text.slice(plainFrom, to) });
  };
  let wordEnd = -1;
  // A 2-kana word is only taken where words must break: at the start (or after a word or
  // punctuation) and before the end, a particle or a number (うえ, えんの → 上, 円 + の).
  const atStart = (i: number) => i === 0 || i === wordEnd || PUNCT_RE.test(text[i - 1]);
  const endsWord = (e: number) =>
    e === text.length ||
    PUNCT_RE.test(text[e]) ||
    PARTICLE_KANA.has(text[e]) ||
    LONG_PARTICLES.some((p) => text.startsWith(p, e)) ||
    !!parseNumber(text, e);
  let i = 0;
  while (i < text.length) {
    // Kana straight after kanji is its okurigana (会いたい), never the start of a word.
    if (!HIRAGANA_RE.test(text[i]) || (i > 0 && hasKanji(text[i - 1]))) {
      i++;
      continue;
    }
    // Straight after a word, a particle kana followed by a word is a particle: おっと|は|いしゃ,
    // not おっと|はいしゃ.
    if (i === wordEnd && PARTICLE_KANA.has(text[i]) && (lex.longestCoreKana(text, i + 1)?.len ?? 0) >= 2) {
      i++;
      continue;
    }
    let word = lex.longestCoreKana(text, i);
    // じゃ ends a word only by chance: にほんじんじゃない is 日本人 + じゃない, not 神社.
    if (word && word.len > 3 && text.startsWith('じゃ', i + word.len - 2)) {
      const shorter = lex.longestCoreKana(text.slice(0, i + word.len - 2), i);
      if (shorter) word = shorter;
    }
    const nums = parseNumber(text, i);
    const numLen = nums ? nums.reduce((n, x) => n + x.kana.length, 0) : 0;
    // The earliest word with this kana decides: はい is "yes" (kana), not 杯.
    const first = word?.words[0];
    const withKanji = first?.written && hasKanji(first.written) ? first : undefined;
    if (nums && numLen > (word?.len ?? 0)) {
      flush(i);
      for (const n of nums) {
        const [detail1, detail2] = n.type === 'counter' ? ['接尾', '助数詞'] : ['数', '*'];
        pieces.push({ start: i, text: n.kana, word: { lemma: n.kanji, pos: '名詞', detail1, detail2 } });
        i += n.kana.length;
      }
      plainFrom = wordEnd = i;
      found = true;
    } else if (word && withKanji && (word.len >= 3 || (atStart(i) && endsWord(i + word.len)))) {
      flush(i);
      const [pos, detail1] = CORE_POS[withKanji.pos] ?? ['名詞', '一般'];
      pieces.push({ start: i, text: text.substr(i, word.len), word: { lemma: withKanji.written!, pos, detail1 } });
      i += word.len;
      plainFrom = wordEnd = i;
      found = true;
    } else if (word && !withKanji && word.len >= 3) {
      i += word.len; // a kana-only word stays whole
      wordEnd = i;
    } else {
      i++;
    }
  }
  flush(text.length);
  return found ? pieces : undefined;
}

/**
 * Tokens for kana pieces: known words as they are, the kana between them through kuromoji,
 * after the preceding word in kanji so that it has its context (電車 + で → で is a particle).
 */
function pieceTokens(tk: Tokenizer<IpadicFeatures>, lex: Lexicon, pieces: KanaPiece[]): Raw[] {
  const out: Raw[] = [];
  pieces.forEach((p, k) => {
    if (p.word) {
      const w = p.word;
      out.push({ ...piece(p.text, p.start, 0, w.lemma, w.pos, w.detail1, w.detail2), kind: classify(w.pos, w.detail1, w.detail2 ?? '*', w.lemma) });
      return;
    }
    if ((p.text === 'お' || p.text === 'ご') && pieces[k + 1]?.word) {
      out.push(piece(p.text, p.start, 0, p.text, '接頭詞', '名詞接続'));
      return;
    }
    const ctx = pieces[k - 1]?.word?.lemma ?? '';
    let toks = ctx ? segmentText(tk, lex, ctx + p.text) : [];
    const cut = toks.findIndex((t) => t.start === ctx.length);
    toks = cut > 0 ? toks.slice(cut) : segmentText(tk, lex, p.text);
    const shift = p.start - (cut > 0 ? ctx.length : 0);
    for (const t of toks) out.push({ ...t, start: t.start + shift, end: t.end + shift });
  });
  return out;
}

/** How unlikely a segmentation is: kana words that are not core words, stray single kana, misplaced particles. */
function segmentationCost(lex: Lexicon, toks: Raw[]): number {
  let cost = 0;
  toks.forEach((t, k) => {
    const prev = toks[k - 1];
    const particle = t.pos === '助詞' || t.pos === '助動詞';
    // A phrase never starts with a particle, and は/が/を/も are never followed by another.
    if (particle && (!prev || prev.kind === 'punct')) cost += 2;
    if (t.pos === '助詞' && prev && TOPIC_CASE.has(prev.surface) && prev.pos === '助詞' && PARTICLE_KANA.has(t.surface)) cost += 2;
    // お/ご go before a noun (ご/ご/さん/じ is 午後 三時), and beginner text has no literary
    // particles (やっ/つつ/くり is 八つ 作り).
    if (t.pos === '接頭詞' && toks[k + 1]?.pos !== '名詞') cost += 2;
    if (t.pos === '助詞' && LITERARY_PARTICLES.has(t.surface)) cost += 2;
    if (t.kind !== 'content' || !HIRAGANA_RE.test(t.surface) || t.detail1 === '固有名詞') return;
    t.lemmaKana = lemmaReading(t.surface, t.lemma, t.reading);
    if (!coreSingle(lex, t, toks[k + 1])) cost += 3;
    if (t.surface.length === 1 && t.detail1 !== '数' && t.detail2 !== '助数詞') cost += 2;
  });
  return cost;
}

/**
 * Tokens for one chunk. Kana text is also cut at the core words and numbers it spells
 * (kanaPieces), and that reading wins when it explains the text better (fewer unknown words
 * and stray kana).
 */
function chunkTokens(tk: Tokenizer<IpadicFeatures>, lex: Lexicon, chunk: Chunk): Raw[] {
  let toks = segmentText(tk, lex, chunk.text);
  const pieces = kanaPieces(lex, chunk.text);
  if (pieces) {
    const other = pieceTokens(tk, lex, pieces);
    if (segmentationCost(lex, other) < segmentationCost(lex, toks)) toks = other;
  }
  for (const t of toks) {
    t.start += chunk.start;
    t.end += chunk.start;
    t.phrase = chunk.phrase;
  }
  return toks;
}

function rawTokens(tk: Tokenizer<IpadicFeatures>, lex: Lexicon, text: RubyText): Raw[] {
  const pt = prepare(text);
  const out = pt.chunks.flatMap((c) => chunkTokens(tk, lex, c));
  joinSplitSuffixes(out);
  applyAuthorReadings(pt, out, lex);
  for (const r of out) r.lemmaKana = lemmaReading(r.surface, r.lemma, r.reading);
  markGrammar(out);
  return out;
}

/** kuromoji sometimes reads a kana name + さん as verb + さ + ん (もりさん → もり/さ/ん). */
function joinSplitSuffixes(toks: Raw[]): void {
  for (let k = toks.length - 2; k >= 1; k--) {
    const a = toks[k];
    const b = toks[k + 1];
    if ((a.surface !== 'さ' && a.surface !== 'ちゃ') || b.surface !== 'ん' || a.end !== b.start) continue;
    if (toks[k - 1].kind === 'punct' || toks[k - 1].end !== a.start) continue;
    const surface = a.surface + 'ん';
    toks.splice(k, 2, { ...a, surface, end: b.end, reading: surface, lemma: surface, pos: '名詞', detail1: '接尾', detail2: '人名', kind: 'content' });
  }
}

/**
 * Grammar spelled with content words: かもしれない's しれ is grammar, not the verb 知れる, and
 * じゃ before ない/ありません is では, not the interjection.
 */
function markGrammar(toks: Raw[]): void {
  for (let k = 0; k + 1 < toks.length; k++) {
    if (toks[k].surface === 'じゃ' && (toks[k + 1].lemma === 'ない' || toks[k + 1].lemma === 'ある')) toks[k].kind = 'function';
  }
  // A lone で/が/と… straight after a noun is the particle, even when kuromoji calls it a
  // conjunction (いじょうで → いじょう + で).
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    if (t.kind === 'content' && PARTICLE_KANA.has(t.surface) && prev.pos === '名詞' && prev.end === t.start && prev.phrase === t.phrase) {
      t.kind = 'function';
      t.pos = '助詞';
    }
  }
  for (let k = 1; k < toks.length; k++) {
    const before = (toks[k - 2]?.surface ?? '') + toks[k - 1].surface;
    if ((toks[k].lemma === 'しれる' || toks[k].lemma === '知れる') && before.endsWith('かも')) toks[k].kind = 'function';
  }
}

/**
 * Replace kuromoji's readings with the author's (kanji the author gave no ruby keep kuromoji's
 * reading). Tokens whose boundary falls inside a ruby
 * segment ({六百|ろっぴゃく} → 六 + 百) form a group: when kuromoji's readings spell the
 * author's reading they stay, otherwise the author's reading is shared out (shareReading:
 * ろく+ひゃく → ろっ+ぴゃく, きゅう+じ → く+じ, よん+じん → よ+にん).
 */
function applyAuthorReadings(pt: PlainText, toks: Raw[], lex: Lexicon): void {
  let i = 0;
  while (i < toks.length) {
    let j = i;
    while (
      j + 1 < toks.length &&
      toks[j].end === toks[j + 1].start &&
      pt.segAt[toks[j].end - 1] >= 0 &&
      pt.segAt[toks[j].end - 1] === pt.segAt[toks[j].end]
    ) j++;
    const author = spanReading(pt, toks[i].start, toks[j].end);
    if (hasKanji(author)) {
      // Kanji without ruby (plain text such as an alternative answer): kuromoji's reading stays.
    } else if (i === j) {
      toks[i].reading = author;
    } else {
      const kuro = toks.slice(i, j + 1).map((t) => t.reading);
      if (kuro.join('') !== author) {
        const group = toks.slice(i, j + 1);
        const shares = shareReading(group.map((t) => lex.readingsOf(t.surface, t.reading)), author);
        group.forEach((t, k) => (t.reading = shares[k]));
      }
    }
    i = j + 1;
  }
}

/** A reading as it may sound inside a compound: voiced at the start (時間 → 〜じかん, 百 → びゃく/ぴゃく), a small っ at the end (六 → ろっ). */
function joinVariants(reading: string): string[] {
  const out = new Set<string>();
  for (const v of soundVariants(reading)) {
    out.add(v);
    if (v.length >= 2) out.add(v.slice(0, -1) + 'っ');
  }
  return [...out];
}

/**
 * Shares the author's reading of a ruby group out over its tokens, given each token's possible
 * readings. Every token takes one of its readings (with joinVariants) when that spells the author's
 * reading ({四人|よにん} → よ+にん); otherwise one token takes whatever the others leave
 * ({九時|くじ} → く+じ, the later token kept first); otherwise the reading is shared out by length,
 * at least one kana each.
 */
export function shareReading(candidates: readonly (readonly string[])[], author: string): string[] {
  const n = candidates.length;
  const options = candidates.map((c) => [...new Set(c.flatMap(joinVariants))].filter(Boolean));
  const solve = (k: number, pos: number, free: number): string[] | undefined => {
    if (k === n) return pos === author.length ? [] : undefined;
    const left = n - k - 1;
    const pieces = k === free
      ? Array.from({ length: Math.max(0, author.length - left - pos) }, (_, len) => author.slice(pos, pos + len + 1))
      : options[k].filter((o) => author.startsWith(o, pos));
    for (const piece of pieces) {
      const rest = solve(k + 1, pos + piece.length, free);
      if (rest) return [piece, ...rest];
    }
    return undefined;
  };
  // free = -1: every token constrained; then one free token, the first one first (a counter's reading is surer
  // than its number's).
  for (let free = -1; free < n; free++) {
    const solved = solve(0, 0, free);
    if (solved) return solved;
  }
  const lengths = candidates.map((c) => Math.max(1, c[0]?.length ?? 1));
  const total = lengths.reduce((a, b) => a + b, 0);
  const out: string[] = [];
  let used = 0;
  for (let k = 0; k < n; k++) {
    const room = author.length - used - (n - k - 1);
    const share = k === n - 1 ? author.length - used : Math.min(room, Math.max(1, Math.round((lengths[k] * author.length) / total)));
    out.push(author.slice(used, used + share));
    used += share;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Matching

const MAX_WINDOW = 8;
const FUNCTION_REF_POS = new Set(['particle-phrase', 'suffix']);

function finish(r: Raw, extra: Partial<RubyToken> = {}): RubyToken {
  const t: RubyToken = { surface: r.surface, reading: r.reading, lemma: r.lemma, pos: r.pos, kind: r.kind, phrase: r.phrase, ...extra };
  if (t.posDetail === undefined && r.detail1 && r.detail1 !== '*') t.posDetail = r.detail1;
  return t;
}

function windowKeys(toks: Raw[], i: number, j: number) {
  const head = toks.slice(i, j);
  const last = toks[j];
  const surf = head.map((t) => t.surface).join('');
  const read = head.map((t) => t.reading).join('');
  const forms = [surf + last.surface];
  const kanas = [read + last.reading];
  if (last.lemma !== last.surface) {
    forms.push(surf + last.lemma);
    kanas.push(read + last.lemmaKana);
  }
  return { forms, kanas, surface: surf + last.surface, reading: read + last.reading };
}

function merged(toks: Raw[], i: number, j: number, lemma: string, ref: TokenRef, corePos?: string): RubyToken {
  const { surface, reading } = windowKeys(toks, i, j);
  const head = toks.slice(i, j + 1).find((t) => t.kind === 'content') ?? toks[i];
  const [pos, detail] = (corePos && CORE_POS[corePos]) || [head.pos, head.detail1];
  const tok: RubyToken = { surface, reading, lemma, pos, ref, kind: 'content', phrase: toks[i].phrase };
  if (detail && detail !== '*') tok.posDetail = detail;
  return tok;
}

/**
 * Splits a merged core word that crosses a '／' phrase mark (おなかが／すいた → お腹がすく,
 * よろしく／おねがいします) into one piece per phrase, each with the word's ref, lemma and kind:
 * every phrase then holds exactly its own text (read-while-listening highlights by `phrase`) and
 * the word keeps its identity.
 */
function splitAtPhrases(tok: RubyToken, toks: readonly Raw[], i: number, j: number): RubyToken[] {
  if (toks[i].phrase === toks[j].phrase) return [tok];
  const out: RubyToken[] = [];
  for (let k = i; k <= j; ) {
    let e = k;
    while (e < j && toks[e + 1].phrase === toks[k].phrase) e++;
    const run = toks.slice(k, e + 1);
    out.push({ ...tok, surface: run.map((t) => t.surface).join(''), reading: run.map((t) => t.reading).join(''), phrase: toks[k].phrase });
    k = e + 1;
  }
  return out;
}

/** Readings of one word that JMdict files as separate entries (何 なん before d/n/t sounds). */
const SAME_WORD_READINGS: Readonly<Record<string, readonly string[]>> = { 何: ['なに', 'なん'] };
/**
 * The author's reading is the core word's, allowing for an お/ご prefix outside the token
 * (お{風呂|ふろ}) and a する verb's noun ({結婚|けっこん}する).
 */
const agrees = (w: CoreWordLite, kanas: string[]) => {
  const kana = toHiragana(w.kana);
  const forms = [kana];
  if (/^[おご]/.test(kana) && /^[おご御]/.test(w.written ?? kana)) forms.push(kana.slice(1));
  if (kana.length > 2 && kana.endsWith('する')) forms.push(kana.slice(0, -2));
  forms.push(...(SAME_WORD_READINGS[w.written ?? ''] ?? []));
  return forms.some((f) => kanas.includes(f));
};

/** A verb or adjective whose written form shares the token's kanji stem and the author's reading. */
function stemMatch(lex: Lexicon, t: Raw): CoreWordLite | undefined {
  let k = t.surface.length;
  while (k > 0 && !hasKanji(t.surface[k - 1])) k--;
  if (!k) return undefined;
  const stem = t.surface.slice(0, k);
  const tail = toHiragana(t.surface.slice(k));
  if (!t.reading.endsWith(tail)) return undefined;
  const readingStem = t.reading.slice(0, t.reading.length - tail.length);
  if (!readingStem) return undefined;
  const wantVerb = t.pos === '動詞';
  const cands = lex.verbsWithKanji.filter((w) => {
    if (w.pos.startsWith('verb') !== wantVerb) return false;
    const rest = w.written!.slice(stem.length);
    const kana = toHiragana(w.kana);
    return w.written!.startsWith(stem) && isKanaWord(rest) && kana.startsWith(readingStem) && kana.length > readingStem.length;
  });
  const score = (w: CoreWordLite) => (w.written!.slice(stem.length).startsWith(t.surface.slice(k)) ? 1 : 0);
  return cands.sort((a, b) => score(b) - score(a) || a.order - b.order)[0];
}

function coreSingle(lex: Lexicon, t: Raw, next?: Raw): CoreWordLite | undefined {
  const forms = [t.surface, t.lemma];
  const kanas = [t.reading, t.lemmaKana];
  // kuromoji often reads a kana noun as a verb stem (みせは → 見せる + は); before は/が/を/の…
  // a word spelled exactly like the surface wins.
  if (t.pos === '動詞' && isKanaWord(t.surface) && next && next.start === t.end && NOUN_PARTICLES.has(next.surface)) {
    const noun = lex.core([t.surface], [t.reading], { kpos: '名詞', strict: true });
    if (noun && !noun.pos.startsWith('verb')) return noun;
  }
  // A kana verb form fits several verbs (おき: 置く or 起きる); take the earliest core verb of a
  // class the form allows.
  if (t.pos === '動詞' && isKanaWord(t.surface)) {
    let best: CoreWordLite | undefined;
    for (const c of [{ form: t.lemma, cls: verbClass(t.ctype) }, ...kanaVerbs(t.surface, t.cform)]) {
      for (const w of lex.coreByForm(c.form)) {
        if (VERB_POS.has(w.pos) && (!c.cls || w.pos === c.cls) && (!best || w.order < best.order)) best = w;
      }
    }
    if (best) return best;
  }
  const direct = lex.core(forms, kanas, { kpos: t.pos });
  if (direct && agrees(direct, kanas)) return direct;
  if ((t.pos === '動詞' || t.pos === '形容詞') && hasKanji(t.surface)) {
    const w = stemMatch(lex, t);
    if (w) return w;
  }
  if (direct) return direct;
  // お/ご: drop it (お茶 → 茶) or add it (茶 → お茶).
  const prefixed = HONORIFIC_PREFIX_RE.test(t.lemma) && t.lemma.length > 1;
  const strip = (s: string) => (HONORIFIC_PREFIX_RE.test(s) ? s.slice(1) : s);
  if (prefixed) {
    const w = lex.core(forms.map(strip), kanas.map(strip), { kpos: t.pos });
    if (w) return w;
  } else if (t.pos === '名詞') {
    for (const p of ['お', 'ご']) {
      const w = lex.core(forms.map((f) => p + f), kanas.map((k) => p + k), { kpos: t.pos, minKana: 3 });
      if (w) return w;
    }
  }
  // する-verbs: 勉強 → 勉強する.
  if (t.pos === '名詞' && t.detail1 === 'サ変接続') {
    const w = lex.core([t.lemma + 'する'], [t.lemmaKana + 'する'], { kpos: '動詞' });
    if (w) return w;
  }
  for (const alias of ALIASES[t.lemma] ?? []) {
    const w = lex.core([alias], [alias], { kpos: t.pos });
    if (w) return w;
  }
  // 読める → 読む, 笑わせる → 笑う; 遊び → 遊ぶ, お待ち → 待つ.
  const verbForms = t.pos === '動詞' ? baseVerbs(t.lemma) : t.pos === '名詞' ? stemVerbs(prefixed ? strip(t.lemma) : t.lemma) : [];
  if (verbForms.length) {
    const w = lex.core(verbForms, [], { kpos: '動詞', onlyPos: VERB_POS });
    if (w) return w;
  }
  return lex.expressionParts.get(t.lemma) ?? lex.expressionParts.get(t.surface);
}

/**
 * A core word for a kana or kanji part, with the reading the part must have when known (a
 * counter may be voiced: 分 ふん read ぷん).
 */
function corePart(lex: Lexicon, part: string, reading: string | undefined, kpos: string): CoreWordLite | undefined {
  if (isKanaWord(part)) return part.length >= 2 ? lex.core([part], [part], { kpos }) : undefined;
  if (!reading) return lex.core([part], [], { kpos });
  return lex.coreByForm(part).find((w) => soundVariants(toHiragana(w.kana)).includes(reading));
}

/** Splits a compound kuromoji token into two or three core words: もう少し → もう + 少し. */
function decompound(lex: Lexicon, t: Raw, depth = 0): RubyToken[] | undefined {
  if (t.kind !== 'content' || t.surface !== t.lemma || t.surface.length < 2 || depth > 1) return undefined;
  const kana = isKanaWord(t.surface);
  for (let k = t.surface.length - 1; k >= 1; k--) {
    const left = t.surface.slice(0, k);
    const right = t.surface.slice(k);
    let leftWord: CoreWordLite | undefined;
    let leftReading = '';
    if (isKanaWord(left)) {
      leftWord = corePart(lex, left, undefined, t.pos);
      leftReading = toHiragana(left);
    } else {
      // The left part reads as whichever of its core readings the token's reading starts with;
      // a numeral may change its sound (四月 しがつ, 六百 ろっぴゃく), so it takes what is left
      // after the right part's reading.
      leftWord = lex.coreByForm(left).find((w) => t.reading.startsWith(toHiragana(w.kana)));
      if (leftWord) leftReading = toHiragana(leftWord.kana);
      const numeral = lex.coreByForm(left).find((w) => w.pos === 'number');
      if (!leftWord && numeral && !isKanaWord(right)) {
        for (const w of lex.coreByForm(right)) {
          const tail = soundVariants(toHiragana(w.kana)).find((v) => t.reading.endsWith(v) && t.reading.length > v.length);
          if (tail) {
            leftWord = numeral;
            leftReading = t.reading.slice(0, t.reading.length - tail.length);
            break;
          }
        }
      }
    }
    if (!leftWord) continue;
    const rightReading = kana ? toHiragana(right) : t.reading.slice(leftReading.length);
    if (!rightReading) continue;
    const rightRaw: Raw = { ...t, surface: right, lemma: right, reading: rightReading, start: t.start + k };
    const leftTok = finish({ ...t, surface: left, lemma: leftWord.written ?? leftWord.kana, reading: leftReading }, { ref: `core:${leftWord.id}` });
    const rightWord = corePart(lex, right, rightReading, t.pos);
    if (rightWord) return [leftTok, finish({ ...rightRaw, lemma: rightWord.written ?? rightWord.kana }, { ref: `core:${rightWord.id}` })];
    const more = decompound(lex, rightRaw, depth + 1);
    if (more) return [leftTok, ...more];
  }
  return undefined;
}

function match(lex: Lexicon, toks: Raw[]): RubyToken[] {
  const out: RubyToken[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === 'punct') {
      out.push(finish(t));
      i++;
      continue;
    }
    let limit = i;
    while (limit + 1 < toks.length && limit + 1 < i + MAX_WINDOW && toks[limit + 1].kind !== 'punct') limit++;

    // 1. The longest run of tokens that spells a core word. In kana text kuromoji may take a
    //    word's first kana for a particle (にちようび → に/ち/ようび): a run may start at a
    //    one-kana particle when it spells a word of 4+ kana and contains a stray single kana.
    const strayStart = t.pos === '助詞' && t.surface.length === 1 && HIRAGANA_RE.test(t.surface);
    if (t.kind === 'content' || t.pos === '接頭詞' || strayStart) {
      let hit: { j: number; w: CoreWordLite } | undefined;
      for (let j = limit; j > i && !hit; j--) {
        if (t.kind === 'function' && !toks.slice(i + 1, j + 1).some((x) => x.surface.length === 1 && x.kind === 'content')) continue;
        const k = windowKeys(toks, i, j);
        // With kanji, the author's reading must fit ({十分|じゅっぷん} is 十 + 分, not 十分).
        const w = lex.core(k.forms, k.kanas, { kpos: toks[i].pos, minKana: t.kind === 'function' ? 4 : 3, strict: hasKanji(k.surface) });
        if (w) hit = { j, w };
      }
      if (hit) {
        out.push(...splitAtPhrases(merged(toks, i, hit.j, hit.w.written ?? hit.w.kana, `core:${hit.w.id}`, hit.w.pos), toks, i, hit.j));
        i = hit.j + 1;
        continue;
      }
    }

    if (t.kind === 'function') {
      // Particles such as だけ/など/しか are core words too; link them without counting them.
      const w = t.pos === '助詞' ? lex.core([t.surface, t.lemma], [t.reading], { kpos: t.pos, onlyPos: FUNCTION_REF_POS }) : undefined;
      out.push(finish(t, w ? { ref: `core:${w.id}` } : {}));
      i++;
      continue;
    }

    // 2. One token, then the token split into core words. A split wins over a word the author's
    //    reading rules out ({三十分|さんじゅっぷん}: 十 + 分, not 十分 じゅうぶん).
    //    A homograph the author reads otherwise is another word when JMdict has it as another
    //    entry: 日 ひ is not the core 日 にち, but 七 しち is the core 七 なな (one JMdict entry).
    //    Derived forms (遊び → 遊ぶ, 結婚 → 結婚する, 風呂 → お風呂) keep their core word.
    const w = coreSingle(lex, t, toks[i + 1]);
    const disagrees = !!w && hasKanji(t.surface) && t.surface === w.written && !agrees(w, [t.reading, t.lemmaKana]);
    const parts = !w || disagrees ? decompound(lex, t) : undefined;
    const other = disagrees && lex.hasJmdict ? lex.jmdict([t.surface, t.lemma], [t.reading, t.lemmaKana], true) : undefined;
    if (w && !parts && !(other && other.id !== w.jmdict)) {
      out.push(finish(t, { ref: `core:${w.id}` }));
      i++;
      continue;
    }
    if (parts) {
      out.push(...parts);
      i++;
      continue;
    }

    // 3. JMdict: the longest written run (生ビール, 店内), then the token alone. Unlike a core
    //    word, a JMdict run stays inside the author's phrase ({方|ほう}が／いい is 方 + いい).
    let jm: { j: number; e: JmdictLite } | undefined;
    for (let j = limit; j > i && !jm && lex.hasJmdict; j--) {
      if (toks[j].phrase !== t.phrase) continue;
      const k = windowKeys(toks, i, j);
      const forms = k.forms.filter((f) => !isKanaWord(f));
      const e = forms.length ? lex.jmdict(forms, k.kanas, false) : undefined;
      if (e) jm = { j, e };
    }
    if (jm) {
      const tok = merged(toks, i, jm.j, jm.e.written || jm.e.kana, `word:${jm.e.id}`);
      if (isName(toks, i, jm.j)) tok.proper = true;
      out.push(tok);
      i = jm.j + 1;
      continue;
    }
    const e = lex.hasJmdict ? lex.jmdict([t.surface, t.lemma], [t.reading, t.lemmaKana], true) : undefined;
    const tok = finish(t, e ? { ref: `word:${e.id}` } : {});
    if (isName(toks, i, i)) tok.proper = true;
    out.push(tok);
    i++;
  }
  return out;
}

/** A person or place name: kuromoji says so, or さん/ちゃん/くん/さま follows a noun or kana. */
function isName(toks: Raw[], i: number, j: number): boolean {
  const t = toks[i];
  if (t.pos === '名詞' && t.detail1 === '固有名詞' && (t.detail2 === '人名' || t.detail2 === '地域')) return true;
  if (t.pos === '名詞' ? t.detail1 === '数' || t.detail1 === '接尾' : !(i === j && isKanaWord(t.surface))) return false;
  const next = toks[j + 1];
  return !!next && next.start === toks[j].end && NAME_SUFFIXES.has(next.surface);
}

// ---------------------------------------------------------------------------------------------
// Loading

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function buildKuromoji(): Promise<Tokenizer<IpadicFeatures>> {
  const kuromoji = require('kuromoji') as typeof import('kuromoji');
  const dicPath = join(dirname(require.resolve('kuromoji/package.json')), 'dict');
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, tk) => (err ? reject(err) : resolve(tk)));
  });
}

/** Words inside core expressions that are not core words themselves (see Lexicon.expressionParts). */
function indexExpressionParts(tk: Tokenizer<IpadicFeatures>, lex: Lexicon, core: CoreWordLite[]): void {
  const parts = new Map<string, CoreWordLite>();
  for (const w of core) {
    if (w.pos !== 'expression') continue;
    for (const t of rawTokens(tk, lex, w.written ?? w.kana)) {
      if (t.kind !== 'content' || coreSingle(lex, t)) continue;
      for (const key of [t.lemma, t.surface]) {
        const prev = parts.get(key);
        if (!prev || prev.order > w.order) parts.set(key, w);
      }
    }
  }
  for (const [k, w] of parts) lex.expressionParts.set(k, w);
}

let kuromojiPromise: Promise<Tokenizer<IpadicFeatures>> | undefined;
let defaultTokenizer: Promise<RubyTokenizer> | undefined;

/** A tokenizer bound to a lexicon. The kuromoji instance is shared and loaded once. */
export async function loadTokenizer(options: TokenizerOptions = {}): Promise<RubyTokenizer> {
  kuromojiPromise ??= buildKuromoji();
  const tk = await kuromojiPromise;
  const core = options.core ?? readJson<CoreWordLite[]>(join(ROOT, 'content', 'core-words.json'));
  let words = options.words;
  if (words === undefined) {
    const path = join(ROOT, 'public', 'data', 'words.json');
    words = existsSync(path) ? readJson<JmdictLite[]>(path) : null;
  }
  const lex = new Lexicon(core, words);
  indexExpressionParts(tk, lex, core);
  return {
    core: lex.coreById,
    hasJmdict: lex.hasJmdict,
    tokenize: (text: RubyText) => match(lex, rawTokens(tk, lex, text)),
  };
}

/** The default tokenizer (content/core-words.json + public/data/words.json), cached. */
export function getTokenizer(): Promise<RubyTokenizer> {
  defaultTokenizer ??= loadTokenizer();
  return defaultTokenizer;
}

/** Tokenizes one ruby text with the default tokenizer. */
export async function tokenizeRuby(text: RubyText): Promise<RubyToken[]> {
  return (await getTokenizer()).tokenize(text);
}

/** Plain text without ruby markup, phrase marks or whitespace (what the reader sees). */
export function plainText(text: RubyText): string {
  return prepare(text).chunks.map((c) => c.text).join('');
}
