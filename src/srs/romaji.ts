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
  /** Output katakana only. */
  katakana?: boolean;
  /**
   * The text is still being typed: keep a trailing unfinished syllable ("k",
   * "ky", a lone "n") as romaji instead of finalizing it.
   */
  partial?: boolean;
}

/** Punctuation an IME turns into its Japanese form; '-' is the long-vowel mark in both scripts (けーき, ケーキ). */
const PUNCTUATION: Record<string, string> = { '-': 'ー', '.': '。', ',': '、', '?': '？', '!': '！' };
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * Capital letters type katakana, as in WanaKana: a syllable written in capitals is katakana when its capitals run is at
 * least two letters long ('KE-KI' → ケーキ, 'kono PAN' → このパン). A single capital ('Ano', a capitalized sentence
 * start) stays hiragana. '-' and an apostrophe join a run ('E-RU' → エール). A run right after katakana continues that
 * word: typed key by key, the earlier capitals are already katakana, so 'PA' + 'N' is パン, not パん. Per position: the
 * run's letter count (0 outside a run), where the run ends, and whether it follows katakana.
 */
function capitalRuns(cased: string): { letters: number[]; end: number[]; afterKatakana: boolean[] } {
  const letters = new Array<number>(cased.length).fill(0);
  const end = new Array<number>(cased.length).fill(0);
  const afterKatakana = new Array<boolean>(cased.length).fill(false);
  for (const m of cased.matchAll(/[A-Z'-]+/g)) {
    const n = (m[0].match(/[A-Z]/g) ?? []).length;
    const continues = m.index > 0 && /[ァ-ヺー]/.test(cased[m.index - 1]);
    for (let i = m.index; i < m.index + m[0].length; i++) {
      letters[i] = n;
      end[i] = m.index + m[0].length;
      afterKatakana[i] = continues;
    }
  }
  return { letters, end, afterKatakana };
}

/**
 * Converts romaji to kana the way a Japanese IME does: double consonants → っ,
 * n'/nn → ん, shi/chi/tsu/fu/ja…, kya/sha/cha…, x/l prefix for small kana,
 * '-' → ー and . , ? ! → 。、？！ (not between digits: 1,500 and 3.5 stay).
 * Hepburn long vowels are written out (gakkō → がっこう). Syllables typed in
 * capitals become katakana (see capitalRuns). Kana and other characters pass
 * through unchanged.
 */
export function toKana(input: string, { katakana = false, partial = false }: ToKanaOptions = {}): string {
  // `s` is lower case for the table; `cased` keeps each letter's case at the same index.
  let s = '';
  let cased = '';
  for (const ch of input.normalize('NFKC').replace(/[‘’`]/g, "'")) {
    const lower = ch.toLowerCase();
    const expanded = LONG_VOWELS[lower] ?? lower;
    const upper = expanded.toUpperCase();
    s += expanded;
    cased += ch === lower || upper.length !== expanded.length ? expanded : upper;
  }
  const runs = capitalRuns(cased);
  /** Every letter in [i, j) is a capital (and there is one). */
  const capitals = (i: number, j: number) => /^[A-Z'-]*[A-Z][A-Z'-]*$/.test(cased.slice(i, j));

  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    let step: Step | undefined;
    if (c === 'n') step = stepN(s, i, partial);
    else if (DOUBLING.includes(c) && (next === c || (c === 't' && next === 'c' && s[i + 2] === 'h'))) step = { kana: 'っ', length: 1 };
    else if (c === 'm' && (next === 'b' || next === 'p')) step = { kana: 'ん', length: 1 }; // Hepburn "shimbun"
    else if (partial && (c === '.' || c === ',') && isDigit(s[i - 1]) && next === undefined) {
      // Typed after a digit, '.' or ',' may still be a separator ('1,500', '3.5'): wait for the next key.
      out += c;
      break;
    } else if (PUNCTUATION[c] && !(isDigit(s[i - 1]) && isDigit(next))) step = { kana: PUNCTUATION[c], length: 1 };
    else step = lookup(s, i);

    if (!step) {
      const rest = s.slice(i);
      if (partial && PREFIXES.has(rest)) {
        out += cased.slice(i);
        break;
      }
      step = { kana: c === "'" ? '' : cased[i], length: 1 };
    }
    if (/^[a-z']+$/.test(step.kana)) {
      // An unfinished syllable kept as typed.
      out += cased.slice(i, i + step.length);
    } else if (!katakana && capitals(i, i + step.length) && /[ぁ-ゖ]/.test(step.kana)) {
      // A lone capital at the end of the field may still start a run ('A' → 'AI' アイ): wait for the next letter.
      if (partial && runs.letters[i] === 1 && runs.end[i] === s.length && !runs.afterKatakana[i]) {
        out += cased.slice(i);
        break;
      }
      out += runs.letters[i] >= 2 || runs.afterKatakana[i] ? toKatakana(step.kana) : step.kana;
    } else {
      out += step.kana;
    }
    i += step.length;
  }
  return katakana ? toKatakana(out) : out;
}

/**
 * The in-field IME: live conversion while the learner types. Complete syllables
 * become kana and an unfinished tail stays as letters ('kit' → 'きt'); "n'" and
 * "nn" → ん; a doubled consonant → っ ('kitte' → 'きって'); '-' → ー and '.' → 。
 * in hiragana too; capitals type katakana ('KE-KI' → ケーキ). Kana already in the
 * field pass through, so converting the field's whole value again is safe.
 */
export function imeConvert(raw: string, opts: { katakana?: boolean } = {}): string {
  return toKana(raw, { katakana: opts.katakana ?? false, partial: true });
}
