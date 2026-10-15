// Ruby markup: "{明日|あした}は{水曜日|すいようび}です。"
// Shared by the app and scripts/build-data.ts (keep it dependency-free).

export interface RubySegment {
  text: string;
  /** Kana reading for `text`, present only for bracketed segments. */
  reading?: string;
}

const RUBY_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;

export function parseRuby(src: string): RubySegment[] {
  const out: RubySegment[] = [];
  let last = 0;
  for (const m of src.matchAll(RUBY_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: src.slice(last, at) });
    out.push({ text: m[1], reading: m[2] });
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/** Text as written, with readings dropped: "明日は水曜日です。" */
export function rubyToPlain(src: string): string {
  return parseRuby(src).map((s) => s.text).join('');
}

/** Text in kana only: "あしたはすいようびです。" */
export function rubyToKana(src: string): string {
  return parseRuby(src).map((s) => s.reading ?? s.text).join('');
}

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/u;
const KANA_RE = /^[぀-ゟ゠-ヿー・ 　]+$/u;

export function isKanji(ch: string): boolean {
  return KANJI_RE.test(ch) && ch !== '々';
}

export function isKanaOnly(s: string): boolean {
  return KANA_RE.test(s);
}

/** Distinct kanji used in a ruby string, in order of appearance. */
export function kanjiIn(src: string): string[] {
  const seen = new Set<string>();
  for (const ch of rubyToPlain(src)) if (isKanji(ch)) seen.add(ch);
  return [...seen];
}

/**
 * Problems with a ruby string, empty when valid:
 * unbalanced braces, empty parts, readings that are not kana,
 * or kanji outside braces (every kanji must carry a reading).
 */
export function validateRuby(src: string): string[] {
  const problems: string[] = [];
  const stripped = src.replace(RUBY_RE, '');
  if (/[{}|]/.test(stripped)) problems.push('unbalanced or malformed ruby braces');
  for (const seg of parseRuby(src)) {
    if (seg.reading !== undefined) {
      if (!isKanaOnly(seg.reading)) problems.push(`reading "${seg.reading}" for "${seg.text}" is not kana`);
      if (!seg.text.trim()) problems.push('empty ruby base');
    } else {
      for (const ch of seg.text) if (isKanji(ch)) problems.push(`kanji "${ch}" has no reading`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Romaji helper (kana sprint only)
// ---------------------------------------------------------------------------

/** Minimal shape of a kana table entry (src/lib/types.ts KanaEntry). */
interface KanaRomaji { char: string; romaji: string }

export interface KanaHelperSegment {
  text: string;
  /** Present on a kana unit the learner has not been taught yet. */
  romaji?: string;
}

const SMALL_KANA = /^[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ]$/u;
const KANA_CHAR = /^[ぁ-ゖゝゞァ-ヺヽヾ]$/u;
/** Units that need no lesson of their own (small tsu, the long-vowel mark). */
const NO_ROMAJI = /^[っッー]$/u;

/** Katakana combinations outside the 208-kana table (kata-extended). */
const EXTENDED_ROMAJI: Record<string, string> = {
  ティ: 'ti', ディ: 'di', デュ: 'dyu', テュ: 'tyu', トゥ: 'tu', ドゥ: 'du', ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo', フュ: 'fyu',
  シェ: 'she', ジェ: 'je', チェ: 'che', ウィ: 'wi', ウェ: 'we', ウォ: 'wo', イェ: 'ye', ヴァ: 'va', ヴィ: 'vi', ヴ: 'vu',
  ヴェ: 've', ヴォ: 'vo', ツァ: 'tsa', ツェ: 'tse', ツォ: 'tso', クァ: 'kwa', グァ: 'gwa',
};

/** Kana units of a string: yōon and small-kana pairs together; っ, ー and anything else on their own. */
function kanaUnitsOf(text: string): string[] {
  const chars = [...text];
  const units: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (KANA_CHAR.test(c) && !SMALL_KANA.test(c) && !NO_ROMAJI.test(c) && next !== undefined && SMALL_KANA.test(next)) {
      units.push(c + next);
      i++;
    } else {
      units.push(c);
    }
  }
  return units;
}

/**
 * Kana units (yōon and small-kana pairs together, っ and ー on their own); romaji only on units containing a kana
 * the learner has not been taught (`taught` holds basic kana chars; voiced/yōon units count as taught once their
 * rule lesson is introduced). Non-kana passes through. Rendered by C's <KanaText> while CourseSnapshot.inSprint; never after.
 */
export function romajiHelper(text: string, taught: ReadonlySet<string>, kana: readonly KanaRomaji[]): KanaHelperSegment[] {
  const table = new Map(kana.map((k) => [k.char, k.romaji]));
  const out: KanaHelperSegment[] = [];
  const pushPlain = (s: string) => {
    const last = out.at(-1);
    if (last && last.romaji === undefined) last.text += s;
    else out.push({ text: s });
  };
  for (const unit of kanaUnitsOf(text)) {
    const isKana = [...unit].every((c) => KANA_CHAR.test(c) || c === 'ー');
    if (!isKana || NO_ROMAJI.test(unit) || taught.has(unit)) {
      pushPlain(unit);
      continue;
    }
    const romaji = table.get(unit) ?? EXTENDED_ROMAJI[unit];
    if (romaji === undefined) pushPlain(unit);
    else out.push({ text: unit, romaji });
  }
  return out;
}
