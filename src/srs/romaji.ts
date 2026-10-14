// IME-style romaji → kana conversion for typed answers.

const VOWELS = 'aiueo';
/** Letters that double into a small っ (kitte, matcha via 'tch'); n is handled separately. */
const DOUBLING = 'bcdfghjklmpqrstvwxyz';

function row(consonant: string, kana: string): Record<string, string> {
  const out: Record<string, string> = {};
  [...kana].forEach((k, i) => {
    out[consonant + VOWELS[i]] = k;
  });
  return out;
}

/** a-i-u-e-o of a yōon row: きゃ, きゅ, きょ and the extended きぇ. */
function yoon(prefix: string, base: string): Record<string, string> {
  return { [prefix + 'a']: base + 'ゃ', [prefix + 'u']: base + 'ゅ', [prefix + 'o']: base + 'ょ', [prefix + 'e']: base + 'ぇ' };
}

const TABLE = new Map<string, string>(
  Object.entries({
    ...row('', 'あいうえお'),
    ...row('k', 'かきくけこ'),
    ...row('g', 'がぎぐげご'),
    ...row('s', 'さしすせそ'),
    ...row('z', 'ざじずぜぞ'),
    ...row('t', 'たちつてと'),
    ...row('d', 'だぢづでど'),
    ...row('n', 'なにぬねの'),
    ...row('h', 'はひふへほ'),
    ...row('b', 'ばびぶべぼ'),
    ...row('p', 'ぱぴぷぺぽ'),
    ...row('m', 'まみむめも'),
    ...row('r', 'らりるれろ'),
    ya: 'や', yu: 'ゆ', yo: 'よ', yi: 'い', ye: 'いぇ',
    wa: 'わ', wi: 'うぃ', wu: 'う', we: 'うぇ', wo: 'を',
    shi: 'し', ji: 'じ', chi: 'ち', tsu: 'つ', fu: 'ふ', dzu: 'づ',
    "n'": 'ん', xn: 'ん',
    ...yoon('ky', 'き'), ...yoon('gy', 'ぎ'),
    ...yoon('sh', 'し'), ...yoon('sy', 'し'),
    ...yoon('j', 'じ'), ...yoon('jy', 'じ'), ...yoon('zy', 'じ'),
    ...yoon('ch', 'ち'), ...yoon('cy', 'ち'), ...yoon('ty', 'ち'),
    ...yoon('dy', 'ぢ'), ...yoon('ny', 'に'), ...yoon('hy', 'ひ'),
    ...yoon('by', 'び'), ...yoon('py', 'ぴ'), ...yoon('my', 'み'), ...yoon('ry', 'り'),
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', fyu: 'ふゅ',
    va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
    tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ',
    thi: 'てぃ', thu: 'てゅ', dhi: 'でぃ', dhu: 'でゅ', twu: 'とぅ', dwu: 'どぅ',
    // Small kana: x- or l- prefix, as on desktop IMEs.
    ...Object.fromEntries(
      [
        ['a', 'ぁ'], ['i', 'ぃ'], ['u', 'ぅ'], ['e', 'ぇ'], ['o', 'ぉ'],
        ['ya', 'ゃ'], ['yu', 'ゅ'], ['yo', 'ょ'], ['wa', 'ゎ'], ['ka', 'ゕ'], ['ke', 'ゖ'],
        ['tu', 'っ'], ['tsu', 'っ'],
      ].flatMap(([r, k]) => [['x' + r, k], ['l' + r, k]]),
    ),
  }),
);

/** Hepburn long vowels (macron or circumflex) as typed out; ō and ē are usually おう and えい. */
const LONG_VOWELS: Record<string, string> = {
  ā: 'aa', ī: 'ii', ū: 'uu', ē: 'ei', ō: 'ou',
  â: 'aa', î: 'ii', û: 'uu', ê: 'ei', ô: 'ou',
};

const MAX_KEY = Math.max(...[...TABLE.keys()].map((k) => k.length));

/** Proper prefixes of table keys: an unfinished syllable while typing. */
const PREFIXES = new Set([...TABLE.keys()].flatMap((k) => [...k].slice(1).map((_, i) => k.slice(0, i + 1))));

interface Step {
  kana: string;
  length: number;
}

function lookup(s: string, i: number): Step | undefined {
  for (let len = Math.min(MAX_KEY, s.length - i); len > 0; len--) {
    const kana = TABLE.get(s.slice(i, i + len));
    if (kana) return { kana, length: len };
  }
  return undefined;
}

const isVowelOrY = (c: string | undefined) => c !== undefined && (VOWELS.includes(c) || c === 'y');

/**
 * The letter n: "na"/"nya" are syllables; "n'" and "nn" are ん, except that
 * before a vowel or y the second n starts the next syllable (konnichiha →
 * こんにちは, minna → みんな); n before any other consonant is ん (shinbun).
 */
function stepN(s: string, i: number, partial: boolean): Step {
  const next = s[i + 1];
  if (next === "'") return { kana: 'ん', length: 2 };
  if (next === undefined) return partial ? { kana: 'n', length: 1 } : { kana: 'ん', length: 1 };
  if (next === 'n') return { kana: 'ん', length: isVowelOrY(s[i + 2]) ? 1 : 2 };
  if (isVowelOrY(next)) {
    const syllable = lookup(s, i);
    if (syllable) return syllable;
    const rest = s.slice(i);
    if (partial && PREFIXES.has(rest)) return { kana: rest, length: rest.length };
  }
  return { kana: 'ん', length: 1 };
}

export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶヽヾ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

export interface ToKanaOptions {
  /** Output katakana, and turn '-' into the long-vowel mark ー. */
  katakana?: boolean;
  /**
   * The text is still being typed: keep a trailing unfinished syllable ("k",
   * "ky", a lone "n") as romaji instead of finalizing it.
   */
  partial?: boolean;
}

/**
 * Converts romaji to kana the way a Japanese IME does: double consonants → っ,
 * n'/nn → ん, shi/chi/tsu/fu/ja…, kya/sha/cha…, x/l prefix for small kana.
 * Hepburn long vowels are written out (gakkō → がっこう). Kana and other
 * characters pass through unchanged.
 */
export function toKana(input: string, { katakana = false, partial = false }: ToKanaOptions = {}): string {
  const s = input.normalize('NFKC').toLowerCase().replace(/[‘’`]/g, "'").replace(/[āīūēōâîûêô]/g, (v) => LONG_VOWELS[v]);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    let step: Step | undefined;
    if (c === 'n') step = stepN(s, i, partial);
    else if (DOUBLING.includes(c) && (next === c || (c === 't' && next === 'c' && s[i + 2] === 'h'))) step = { kana: 'っ', length: 1 };
    else if (c === 'm' && (next === 'b' || next === 'p')) step = { kana: 'ん', length: 1 }; // Hepburn "shimbun"
    else if (c === '-') step = { kana: katakana ? 'ー' : '-', length: 1 };
    else step = lookup(s, i);

    if (!step) {
      const rest = s.slice(i);
      if (partial && PREFIXES.has(rest)) {
        out += rest;
        break;
      }
      step = { kana: c === "'" ? '' : c, length: 1 };
    }
    out += step.kana;
    i += step.length;
  }
  return katakana ? toKatakana(out) : out;
}
