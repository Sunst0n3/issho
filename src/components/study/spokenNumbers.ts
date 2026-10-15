// Whether a speech-recognition transcript says a numbers-drill item. Recognizers write what they hear as kana, as
// digits ('300', '1500円', '4時10分', '3本') or as kanji numerals ('三本', '百万'), so each form is accepted, but only
// exactly: a near miss of a number is a different number.

import { normalizeForCompare } from '../../speech/compare.ts';
import type { NumberDrillItem } from '../../srs/numbersDrill.ts';

const KANJI_DIGITS: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const BIG_UNITS: Record<string, number> = { 万: 10_000, 億: 100_000_000 };
const NUMERAL = '[0-9〇零一二三四五六七八九十百千万億]+';

/** Spaces, commas and sentence punctuation a recognizer may add around the answer. */
const NOISE_RE = /[\s,，、。．.!！?？]/g;

/**
 * pure: the value of a number written in digits, kanji numerals or a mix ('1500', '1万5000', '千五百', '100万');
 * null when it isn't one.
 */
export function writtenNumber(text: string): number | null {
  const s = text.normalize('NFKC').replace(/,/g, '');
  if (!new RegExp(`^${NUMERAL}$`).test(s)) return null;
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
      digit = Number(s.slice(i, j));
      i = j - 1;
    } else if (ch in KANJI_DIGITS) {
      digit = KANJI_DIGITS[ch];
    } else if (ch in SMALL_UNITS) {
      section += (digit ?? 1) * SMALL_UNITS[ch];
      digit = null;
    } else {
      total += (section + (digit ?? 0) || 1) * BIG_UNITS[ch];
      section = 0;
      digit = null;
    }
  }
  return total + section + (digit ?? 0);
}

/** pure: the transcript says the item, as kana or as the number written out (with its ¥/円, 時/分 or counter). */
export function spokenNumberMatches(transcript: string, item: NumberDrillItem): boolean {
  const said = normalizeForCompare(transcript).join('');
  if (!said) return false;
  if (item.answers.some((a) => normalizeForCompare(a).join('') === said)) return true;

  const heard = transcript.normalize('NFKC').replace(NOISE_RE, '');
  switch (item.kind) {
    case 'number':
      return writtenNumber(heard) === Number(item.prompt.replace(/,/g, ''));
    case 'price': {
      const m = heard.match(new RegExp(`^(¥)?(${NUMERAL})(円)?$`));
      return Boolean(m && (m[1] || m[3])) && writtenNumber(m![2]) === Number(item.prompt.replace(/[¥,]/g, ''));
    }
    case 'time': {
      const [h, min] = item.prompt.split(':').map(Number);
      const m = heard.match(new RegExp(`^(${NUMERAL})(?:時|:)(?:(半)|(${NUMERAL})分?)?$`));
      if (!m) return false;
      const minutes = m[2] ? 30 : m[3] ? writtenNumber(m[3]) : 0;
      return writtenNumber(m[1]) === h && minutes === min;
    }
    case 'counter': {
      const n = Number.parseInt(item.prompt, 10);
      const counter = item.prompt.replace(/^[0-9]+/, '');
      const m = heard.match(new RegExp(`^(${NUMERAL})(.+)$`));
      return Boolean(m) && m![2] === counter && writtenNumber(m![1]) === n;
    }
  }
}
