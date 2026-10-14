// Tokenizes ruby text ('{昨日|きのう}の{晩|ばん}ご{飯|はん}…') into words and links each one to a
// core word (content/core-words.json) or, failing that, a JMdict entry (public/data/words.json).
//
//   const tokens = await tokenizeRuby('{毎日|まいにち}{日本語|にほんご}を{勉強|べんきょう}しています。');
//
// How it works:
// - '／' phrase marks and whitespace split the text into chunks; each chunk is tokenized by
//   kuromoji (IPADIC) on its own. Phrase breaks are always word breaks, and this helps a lot
//   with kana-only text. Ruby markup is stripped and the author's readings replace kuromoji's.
// - Words are matched longest-first: a run of kuromoji tokens that spells a core word is
//   merged into one token (食べ+放題 → 食べ放題, 勉強+し → 勉強する, お+願い+し+ます →
//   お願いします, まい+あ+さ → まいあさ). Single tokens then match by written form or kana,
//   with the author's reading choosing between homographs (人 ひと/にん/じん, 一日 いちにち/
//   ついたち), お/ご prefixes added or dropped, nouns tried as する-verbs, and ない → ある,
//   よい → いい.
// - kind: particles, auxiliaries (ます/た/ない/です/たい…), grammatical helpers (ている's いる,
//   nominal の/こと, そう/よう stems, passive/causative endings), the お/ご prefix and numbers
//   written in digits are 'function'; symbols are 'punct'; everything else is 'content'.
// - proper: a person or place name that is not a core word (kuromoji's 固有名詞 人名/地域, or
//   any word followed by さん/ちゃん/くん/さま). Coverage does not count these.

import { readFileSync, existsSync } from 'node:fs';
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
  /** Dictionary form (kuromoji's basic_form); for merged words, the matched headword. */
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
}

/** The fields of a public/data/words.json entry the tokenizer uses. */
export interface JmdictLite {
  id: string;
  written: string;
  kana: string;
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

/** Dictionary forms kuromoji gives that the core list teaches under another headword. */
const ALIASES: Record<string, string[]> = {
  ない: ['ある'],
  無い: ['ある'],
  よい: ['いい'],
  良い: ['いい'],
  善い: ['いい'],
};

const NAME_SUFFIXES = new Set(['さん', 'ちゃん', 'くん', '君', 'さま', '様']);
const HONORIFIC_PREFIXES = ['お', 'ご'];

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
  readonly hasJmdict: boolean;

  constructor(core: CoreWordLite[], words: JmdictLite[] | null) {
    for (const w of core) {
      this.coreById.set(w.id, w);
      if (w.written) push(this.coreWritten, w.written, w);
      push(this.coreKana, toHiragana(w.kana), w);
    }
    this.hasJmdict = !!words;
    for (const w of words ?? []) {
      if (w.written) push(this.jmWritten, w.written, w);
      push(this.jmKana, toHiragana(w.kana), w);
    }
  }

  /**
   * Best core word spelled by one of `forms` (written, or kana when the form is all kana), or,
   * for forms with kanji, read as one of `kanas` (a word the core list writes in kana, or one
   * spelled with a shared kanji: 御飯/ご飯, 分かる/分る).
   */
  core(forms: string[], kanas: string[], kpos: string, minKana = 1, onlyPos?: Set<string>): CoreWordLite | undefined {
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
    if (onlyPos) list = list.filter((w) => onlyPos.has(w.pos));
    if (!list.length) return undefined;
    const compat = POS_COMPAT[kpos] ?? [];
    const score = (w: CoreWordLite) =>
      (kanaSet.has(toHiragana(w.kana)) ? 2 : 0) + (compat.includes(w.pos) ? 1 : 0);
    return list.sort((a, b) => score(b) - score(a) || a.order - b.order)[0];
  }

  /** Best JMdict entry for written `forms` (and kana-only forms when allowed). */
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
    const isBreak = i === plain.length || (BREAK_RE.test(ch) && segAt[i] === -1);
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
  kind: TokenKind;
  phrase: number;
}

function classify(f: IpadicFeatures): TokenKind {
  const s = f.surface_form;
  const d1 = f.pos_detail_1;
  if (f.pos === '記号' || PUNCT_RE.test(s)) return 'punct';
  if (f.pos === '助詞' || f.pos === '助動詞') return 'function';
  if (f.pos === '接頭詞' && (s === 'お' || s === 'ご' || s === '御')) return 'function';
  if (f.pos === '動詞' && (d1 === '非自立' || d1 === '接尾')) return 'function';
  if (f.pos === '形容詞' && (d1 === '非自立' || d1 === '接尾')) return 'function';
  if (f.pos === '名詞' && (d1 === '非自立' || d1 === '特殊')) return 'function';
  if (f.pos === '名詞' && d1 === '接尾' && f.pos_detail_2 === '助動詞語幹') return 'function';
  if (DIGITS_RE.test(s) || LATIN_RE.test(s)) return 'function';
  return 'content';
}

function rawTokens(tk: Tokenizer<IpadicFeatures>, pt: PlainText): Raw[] {
  const out: Raw[] = [];
  for (const chunk of pt.chunks) {
    let at = chunk.start;
    for (const f of tk.tokenize(chunk.text)) {
      const surface = f.surface_form;
      const start = at;
      at += surface.length;
      if (!surface.trim()) continue;
      const kuro = f.reading && f.reading !== '*' ? toHiragana(f.reading) : toHiragana(surface);
      out.push({
        surface,
        start,
        end: at,
        reading: kuro,
        lemma: f.basic_form && f.basic_form !== '*' ? f.basic_form : surface,
        lemmaKana: '',
        pos: f.pos,
        detail1: f.pos_detail_1,
        detail2: f.pos_detail_2,
        kind: classify(f),
        phrase: chunk.phrase,
      });
    }
  }
  joinSplitSuffixes(out);
  applyAuthorReadings(pt, out);
  for (const r of out) r.lemmaKana = lemmaReading(r.surface, r.lemma, r.reading);
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
    toks.splice(k, 2, {
      ...a,
      surface,
      end: b.end,
      reading: surface,
      lemma: surface,
      pos: '名詞',
      detail1: '接尾',
      detail2: '人名',
      kind: 'content',
    });
  }
}

/**
 * Replace kuromoji's readings with the author's. Tokens whose boundary falls inside a ruby
 * segment ({六百|ろっぴゃく} → 六 + 百) form a group: when kuromoji's readings spell the
 * author's reading they stay, otherwise the author's reading is shared out by length
 * (ろく+ひゃく → ろっ+ぴゃく).
 */
function applyAuthorReadings(pt: PlainText, toks: Raw[]): void {
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
    if (i === j) {
      toks[i].reading = author;
    } else {
      const kuro = toks.slice(i, j + 1).map((t) => t.reading);
      if (kuro.join('') !== author) {
        const total = kuro.reduce((n, r) => n + r.length, 0) || 1;
        let used = 0;
        for (let k = i; k <= j; k++) {
          const share = k === j ? author.length - used : Math.round((kuro[k - i].length * author.length) / total);
          toks[k].reading = author.slice(used, used + share);
          used += share;
        }
      }
    }
    i = j + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Matching

const MAX_WINDOW = 8;
const FUNCTION_REF_POS = new Set(['particle-phrase', 'suffix']);

function finish(r: Raw, extra: Partial<RubyToken> = {}): RubyToken {
  const t: RubyToken = {
    surface: r.surface,
    reading: r.reading,
    lemma: r.lemma,
    pos: r.pos,
    kind: r.kind,
    phrase: r.phrase,
    ...extra,
  };
  if (r.detail1 && r.detail1 !== '*' && !t.posDetail) t.posDetail = r.detail1;
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

/** IPADIC part of speech for a core word's pos, where it has a clear one. */
const CORE_POS: Record<string, string> = {
  noun: '名詞',
  pronoun: '名詞',
  number: '名詞',
  counter: '名詞',
  suffix: '名詞',
  'adj-na': '名詞',
  'verb-ru': '動詞',
  'verb-u': '動詞',
  'verb-irr': '動詞',
  'adj-i': '形容詞',
  adverb: '副詞',
  interjection: '感動詞',
  conjunction: '接続詞',
  prefix: '接頭詞',
};

function merged(toks: Raw[], i: number, j: number, lemma: string, ref: TokenRef, corePos?: string): RubyToken {
  const { surface, reading } = windowKeys(toks, i, j);
  const head = toks.slice(i, j + 1).find((t) => t.kind === 'content') ?? toks[i];
  const pos = (corePos && CORE_POS[corePos]) || head.pos;
  const tok: RubyToken = { surface, reading, lemma, pos, ref, kind: 'content', phrase: toks[i].phrase };
  if (pos === head.pos && head.detail1 !== '*') tok.posDetail = head.detail1;
  return tok;
}

function coreSingle(lex: Lexicon, t: Raw): CoreWordLite | undefined {
  const forms = [t.surface, t.lemma];
  const kanas = [t.reading, t.lemmaKana];
  const hit = lex.core(forms, kanas, t.pos);
  if (hit) return hit;
  // お/ご: drop it (お茶 → 茶) or add it (茶 → お茶).
  const first = t.lemma[0];
  if ((HONORIFIC_PREFIXES.includes(first) || first === '御') && t.lemma.length > 1) {
    const strip = (s: string) => (/^[おご御]/u.test(s) ? s.slice(1) : s);
    const w = lex.core(forms.map(strip), kanas.map(strip), t.pos);
    if (w) return w;
  } else if (t.pos === '名詞') {
    for (const p of HONORIFIC_PREFIXES) {
      const w = lex.core(forms.map((f) => p + f), kanas.map((k) => p + k), t.pos, 3);
      if (w) return w;
    }
  }
  // する-verbs: 勉強 → 勉強する.
  if (t.pos === '名詞' && t.detail1 === 'サ変接続') {
    const w = lex.core([t.lemma + 'する'], [t.lemmaKana + 'する'], '動詞');
    if (w) return w;
  }
  for (const alias of ALIASES[t.lemma] ?? []) {
    const w = lex.core([alias], [alias], t.pos);
    if (w) return w;
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
    const canStart = t.kind === 'content' || t.pos === '接頭詞';
    let limit = i;
    while (limit + 1 < toks.length && limit + 1 < i + MAX_WINDOW && toks[limit + 1].kind !== 'punct') limit++;

    if (canStart) {
      // 1. Longest run of tokens that spells a core word.
      let done = false;
      for (let j = limit; j > i && !done; j--) {
        const k = windowKeys(toks, i, j);
        const w = lex.core(k.forms, k.kanas, toks[i].pos, 3);
        if (w) {
          out.push(merged(toks, i, j, w.written ?? w.kana, `core:${w.id}`, w.pos));
          i = j + 1;
          done = true;
        }
      }
      if (done) continue;
    }

    if (t.kind === 'function') {
      // Particles such as だけ/など/しか are core words too; link them without counting them.
      const w = lex.core([t.surface, t.lemma], [t.reading], t.pos, 1, FUNCTION_REF_POS);
      out.push(finish(t, w ? { ref: `core:${w.id}` } : {}));
      i++;
      continue;
    }

    // 2. One token.
    const w = coreSingle(lex, t);
    if (w) {
      out.push(finish(t, { ref: `core:${w.id}` }));
      i++;
      continue;
    }

    // 3. JMdict: longest written run (食べ放題, 生ビール), then the token alone.
    let done = false;
    for (let j = limit; j > i && !done && lex.hasJmdict; j--) {
      const k = windowKeys(toks, i, j);
      const forms = k.forms.filter((f) => !isKanaWord(f));
      if (!forms.length) continue;
      const e = lex.jmdict(forms, k.kanas, false);
      if (e) {
        const tok = merged(toks, i, j, e.written || e.kana, `word:${e.id}`);
        if (isName(toks, i, j)) tok.proper = true;
        out.push(tok);
        i = j + 1;
        done = true;
      }
    }
    if (done) continue;
    const e = lex.hasJmdict ? lex.jmdict([t.surface, t.lemma], [t.reading, t.lemmaKana], true) : undefined;
    const tok = finish(t, e ? { ref: `word:${e.id}` } : {});
    if (isName(toks, i, i)) tok.proper = true;
    out.push(tok);
    i++;
  }
  return out;
}

/** A person or place name: kuromoji says so, or さん/ちゃん/くん/さま follows it. */
function isName(toks: Raw[], i: number, j: number): boolean {
  const t = toks[i];
  if (t.pos === '名詞' && t.detail1 === '固有名詞' && (t.detail2 === '人名' || t.detail2 === '地域')) return true;
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
  return {
    core: lex.coreById,
    hasJmdict: lex.hasJmdict,
    tokenize(text: RubyText): RubyToken[] {
      return match(lex, rawTokens(tk, prepare(text)));
    },
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
