// VOICEVOX helpers shared by the audio generator (scripts/audio), the server TTS proxy (server/src/tts.ts) and the
// app's clip lookup (src/speech/audio.ts). Dependency-free and erasable TypeScript only, so Node runs it directly.
//
// Readings are compared in a "comparison form" because VOICEVOX writes what it hears, not the spelling:
// 先生 センセエ, 東京 トオキョオ, コーヒー コオヒイ, 駅へ エキエ, 本を ホンオ.

import type { VoiceId } from './api.ts';

export const VOICES: Record<VoiceId, { speaker: number; style: string; credit: string }> = {
  f: { speaker: 30, style: 'No.7 アナウンス', credit: 'VOICEVOX:No.7' },
  m: { speaker: 13, style: '青山龍星 ノーマル', credit: 'VOICEVOX:青山龍星' },
};

/** Clip refs (AudioManifest.byRef keys). Indexes are 0-based positions in the source arrays. */
export const clipRef = {
  kana: (char: string) => `kana:${char}`,
  kanaEx: (char: string) => `kanaEx:${char}`,
  kanaRule: (ruleId: string, n: number) => `kanaRule:${ruleId}#${n}`,
  /** A word ref ('core:cw-0001', 'word:1234567') is its own clip ref. */
  word: (ref: string) => ref,
  pitch: (wordRef: string) => `pitch:${wordRef}`,
  grammarExample: (id: string, n: number) => `grammar:${id}#ex${n}`,
  grammarBuild: (id: string, n: number) => `grammar:${id}#build${n}`,
  sentence: (id: string) => `sentence:${id}`,
  story: (id: string, n: number) => `story:${id}#${n}`,
  rolePlay: (id: string, n: number) => `rp:${id}#${n}`,
  task: (taskId: string, n: number) => `task:${taskId}#${n}`,
  canDo: (id: string) => `cando:${id}`,
} as const;

// ---------------------------------------------------------------------------
// Ruby (same semantics as src/lib/ruby.ts, plus the story phrase mark '／' removed)

const RUBY_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;
const PHRASE_MARK_RE = /／/g;

/** Text as written, readings dropped: '{明日|あした}は／晴れ' → '明日は晴れ'. */
export function rubyPlain(text: string): string {
  return text.replace(RUBY_RE, (_m, base: string) => base).replace(PHRASE_MARK_RE, '');
}

/** Text with every ruby base replaced by its reading: '{明日|あした}は／晴れ' → 'あしたは晴れ'. */
export function rubyKana(text: string): string {
  return text.replace(RUBY_RE, (_m, _base: string, reading: string) => reading).replace(PHRASE_MARK_RE, '');
}

// ---------------------------------------------------------------------------
// Kana

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/u;

/** Hiragana → katakana (ゝゞ included); everything else unchanged. */
export function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Small kana that join the previous kana into one mora (ゃ in きゃ, ィ in ティ). っ/ッ is a mora of its own. */
const JOINERS = new Set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ');

/** Kana → moras: small ゃゅょぁぃぅぇぉゎ (and katakana) join the previous kana; っ, ん, ー are moras of their own. */
export function splitMoras(kana: string): string[] {
  const out: string[] = [];
  for (const ch of kana) {
    if (JOINERS.has(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

type Vowel = 'a' | 'i' | 'u' | 'e' | 'o';
const VOWEL_KANA: Record<Vowel, string> = { a: 'ア', i: 'イ', u: 'ウ', e: 'エ', o: 'オ' };
const VOWELS = new Map<string, Vowel>();
for (const [v, chars] of [
  ['a', 'アカサタナハマヤラワガザダバパァャヮ'],
  ['i', 'イキシチニヒミリギジヂビピィヰ'],
  ['u', 'ウクスツヌフムユルグズヅブプゥュヴ'],
  ['e', 'エケセテネヘメレゲゼデベペェヱ'],
  ['o', 'オコソトノホモヨロヲゴゾドボポォョ'],
] as const) {
  for (const ch of chars) VOWELS.set(ch, v);
}

/** Vowel of a katakana mora (its last kana decides: キャ → a); null for ン, ッ, ー and non-kana. */
function moraVowel(mora: string): Vowel | null {
  return VOWELS.get(mora[mora.length - 1]) ?? null;
}

/** Punctuation, symbols and spaces: never part of a reading. ー is a letter (Lm) and stays. */
const NOT_READING_RE = /[\p{P}\p{S}\p{Z}\s]/gu;

const MORA_SUBSTITUTES: Record<string, string> = { ハ: 'ワ', ヘ: 'エ', ヲ: 'オ' };
const CHAR_SUBSTITUTES: Record<string, string> = { ヅ: 'ズ', ヂ: 'ジ' };

/**
 * Comparison form (apply to both sides): katakana; punctuation and spaces removed; ー → the previous mora's vowel;
 * ハ→ワ, ヘ→エ, ヲ→オ; ヅ→ズ, ヂ→ジ; after an e-column mora イ→エ; after an o-column mora ウ→オ; ユウ→イウ
 * (エウ after an e-column mora; 言う is said ゆう, and the engine writes どういう ドオユウ but という トイウ).
 * (VOICEVOX writes 先生 センセエ, 東京 トオキョオ, コーヒー コオヒイ, 駅へ エキエ, 本を ホンオ.)
 */
export function normalizeMoras(kana: string): string {
  const moras = splitMoras(toKatakana(kana.normalize('NFKC')).replace(NOT_READING_RE, ''));
  const out: string[] = [];
  for (const raw of moras) {
    const prev = out.length > 0 ? moraVowel(out[out.length - 1]) : null;
    let mora = MORA_SUBSTITUTES[raw] ?? raw;
    mora = (CHAR_SUBSTITUTES[mora[0]] ?? mora[0]) + mora.slice(1);
    if (mora === 'ー' && prev) mora = VOWEL_KANA[prev];
    else if (mora === 'イ' && prev === 'e') mora = 'エ';
    else if (mora === 'ウ' && prev === 'o') mora = 'オ';
    if (mora === 'ウ' && out[out.length - 1] === 'ユ') {
      // The イ that ユ stands for follows the e-column rule too, so てゆう and ていう (テエウ) still compare equal.
      const before = out.length > 1 ? moraVowel(out[out.length - 2]) : null;
      out[out.length - 1] = before === 'e' ? 'エ' : 'イ';
    }
    out.push(mora);
  }
  return out.join('');
}

function normalizeKeyPart(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * `${voice}|${plain}|${reading}`: plain = rubyPlain(text) without '／', NFKC, whitespace collapsed, trimmed; reading =
 * hiragana of rubyKana(text) normalised the same way, or '' when it still contains a kanji (text without full ruby).
 * '{食|た}べる' and '{食べる|たべる}' → 'f|食べる|たべる'; '食べる' → 'f|食べる|'; 'ありがとう' → 'f|ありがとう|ありがとう'.
 */
export function clipTextKey(voice: VoiceId, text: string): string {
  const plain = normalizeKeyPart(rubyPlain(text));
  const reading = toHiragana(normalizeKeyPart(rubyKana(text)));
  return `${voice}|${plain}|${KANJI_RE.test(reading) ? '' : reading}`;
}

// ---------------------------------------------------------------------------
// Engine queries (VOICEVOX /audio_query)

export interface VvMora {
  text: string;
  consonant?: string | null;
  consonant_length?: number | null;
  vowel: string;
  vowel_length: number;
  pitch: number;
}
export interface VvAccentPhrase {
  moras: VvMora[];
  accent: number;
  pause_mora: VvMora | null;
  is_interrogative?: boolean;
}
export interface VvQuery {
  accent_phrases: VvAccentPhrase[];
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  volumeScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
  outputStereo: boolean;
  kana?: string;
  [key: string]: unknown;
}

/** Concatenated mora texts of the query (katakana, pause moras left out). */
export function queryMoras(q: VvQuery): string {
  return q.accent_phrases.map((p) => p.moras.map((m) => m.text).join('')).join('');
}

/** The engine read `expectedKana` (normalizeMoras equality of both sides). */
export function readingMatches(q: VvQuery, expectedKana: string): boolean {
  const expected = normalizeMoras(expectedKana);
  return expected.length > 0 && normalizeMoras(queryMoras(q)) === expected;
}

export interface AccentInfoShared {
  moras: string[];
  drop: number;
  type: 'heiban' | 'atamadaka' | 'nakadaka' | 'odaka';
}

/** Moras of an expected reading as AccentInfo stores them: katakana, long vowels kept as ー, no punctuation. */
function expectedMoras(expectedKana: string): string[] {
  return splitMoras(toKatakana(expectedKana.normalize('NFKC')).replace(NOT_READING_RE, ''));
}

/** The query is one accent phrase of `count` moras whose reading matches `expectedKana`. */
function singlePhrase(q: VvQuery, count: number, expectedKana: string): VvAccentPhrase | null {
  if (q.accent_phrases.length !== 1) return null;
  const phrase = q.accent_phrases[0];
  if (phrase.moras.length !== count || !readingMatches(q, expectedKana)) return null;
  if (phrase.accent < 1 || phrase.accent > count) return null;
  return phrase;
}

/** True when `withGa` (the query of word + が) lines up with the word: one accent phrase of n + 1 moras. */
export function gaAligned(expectedKana: string, withGa: VvQuery): boolean {
  const n = expectedMoras(expectedKana).length;
  return n > 0 && singlePhrase(withGa, n + 1, `${expectedKana}が`) !== null;
}

function accentType(drop: number, n: number): AccentInfoShared['type'] {
  if (drop === 0) return 'heiban';
  if (drop === 1) return 'atamadaka';
  return drop === n ? 'odaka' : 'nakadaka';
}

/**
 * alone: query of the word; withGa: query of word + 'が' (nouns, pronouns, na-adjectives, numbers, counters), else null.
 * n = moras of the expected reading. withGa with one accent phrase of n+1 moras: accent n+1 → drop 0 (heiban), else
 * drop = accent. Otherwise alone with one phrase of n moras: accent n → 0, else accent. Types: 0 heiban, 1 atamadaka,
 * n odaka, else nakadaka (1-mora words: 0 heiban, else atamadaka). null when the phrases don't line up.
 */
export function accentFromQueries(
  expectedKana: string,
  alone: VvQuery,
  withGa: VvQuery | null,
): AccentInfoShared | null {
  const moras = expectedMoras(expectedKana);
  const n = moras.length;
  if (n === 0) return null;
  let drop: number | null = null;
  const ga = withGa ? singlePhrase(withGa, n + 1, `${expectedKana}が`) : null;
  if (ga) {
    drop = ga.accent === n + 1 ? 0 : ga.accent;
  } else {
    const phrase = singlePhrase(alone, n, expectedKana);
    if (phrase) drop = phrase.accent === n ? 0 : phrase.accent;
  }
  if (drop === null) return null;
  return { moras, drop, type: accentType(drop, n) };
}

// ---------------------------------------------------------------------------
// Timing

/** The engine renders at 93.75 frames a second and rounds every phoneme to whole frames. */
const FRAME_RATE = 93.75;
/** A question's rising end: the engine appends one 0.15-s mora to an interrogative accent phrase whose last mora is
 *  voiced (pitch > 0); a devoiced last mora gets none. */
const UPSPEAK_SEC = 0.15;

interface TimedMora {
  sec: number;
  /** A spoken mora of the query (false for pauses and the question upspeak). */
  spoken: boolean;
}

function timeline(q: VvQuery): { pre: number; items: TimedMora[] } {
  const speed = q.speedScale > 0 ? q.speedScale : 1;
  const frames = (sec: number) => Math.round((sec / speed) * FRAME_RATE);
  const toSec = (f: number) => f / FRAME_RATE;
  const items: TimedMora[] = [];
  for (const phrase of q.accent_phrases) {
    for (const m of phrase.moras) {
      items.push({ sec: toSec(frames(m.consonant_length ?? 0) + frames(m.vowel_length)), spoken: true });
    }
    const last = phrase.moras[phrase.moras.length - 1];
    if (phrase.is_interrogative && last && last.pitch > 0) items.push({ sec: toSec(frames(UPSPEAK_SEC)), spoken: false });
    if (phrase.pause_mora) {
      const p = phrase.pause_mora;
      items.push({ sec: toSec(frames(p.consonant_length ?? 0) + frames(p.vowel_length)), spoken: false });
    }
  }
  return { pre: toSec(frames(q.prePhonemeLength)), items };
}

/**
 * Start offsets (ms) of the author's phrases inside the query: each phrase's normalized mora count is walked over the
 * query's moras (pause_mora included where present); offset = 1000·(prePhonemeLength + Σ consonant_length +
 * vowel_length of earlier moras and pauses) / speedScale, each length rounded to the engine's frames. aligned = false
 * (proportional offsets by mora count) when counts don't match.
 */
export function phraseOffsetsMs(q: VvQuery, phrasesKana: readonly string[]): { offsets: number[]; aligned: boolean } {
  const { pre, items } = timeline(q);
  const counts = phrasesKana.map((p) => splitMoras(normalizeMoras(p)).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const spoken = items.filter((i) => i.spoken).length;
  const ms = (sec: number) => Math.round(sec * 1000);

  if (total === spoken && counts.every((c) => c > 0)) {
    const offsets: number[] = [];
    let at = 0;
    let t = pre;
    for (const count of counts) {
      // A phrase starts at its first spoken mora: pauses before it belong to the gap.
      while (at < items.length && !items[at].spoken) t += items[at++].sec;
      offsets.push(ms(t));
      for (let left = count; left > 0; at++) {
        t += items[at].sec;
        if (items[at].spoken) left--;
      }
    }
    return { offsets, aligned: true };
  }

  const speech = items.reduce((a, i) => a + i.sec, 0);
  const offsets: number[] = [];
  let before = 0;
  for (const count of counts) {
    offsets.push(ms(pre + (total > 0 ? (speech * before) / total : 0)));
    before += count;
  }
  return { offsets, aligned: false };
}

/** Accent phrases of a sentence query as [joined katakana moras, accent] (pause moras left out): AudioClip.accentPhrases. */
export function phraseAccents(q: VvQuery): [string, number][] {
  return q.accent_phrases
    .filter((p) => p.moras.length > 0)
    .map((p) => [p.moras.map((m) => m.text).join(''), p.accent]);
}
