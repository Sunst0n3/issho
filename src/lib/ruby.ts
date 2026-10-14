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
