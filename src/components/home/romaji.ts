// Kana → Hepburn romaji for showing readings ("みず" → "mizu", "スイ" → "sui").
// Display only: long vowels stay spelled out ("きょう" → "kyou") so the learner
// can map each letter group back to a kana.

import { toHiragana } from '../../srs/romaji.ts';

const ROWS: Array<[string, string]> = [
  ['あいうえお', 'a i u e o'],
  ['かきくけこ', 'ka ki ku ke ko'],
  ['さしすせそ', 'sa shi su se so'],
  ['たちつてと', 'ta chi tsu te to'],
  ['なにぬねの', 'na ni nu ne no'],
  ['はひふへほ', 'ha hi fu he ho'],
  ['まみむめも', 'ma mi mu me mo'],
  ['やゆよ', 'ya yu yo'],
  ['らりるれろ', 'ra ri ru re ro'],
  ['わゐゑをん', 'wa i e o n'],
  ['がぎぐげご', 'ga gi gu ge go'],
  ['ざじずぜぞ', 'za ji zu ze zo'],
  ['だぢづでど', 'da ji zu de do'],
  ['ばびぶべぼ', 'ba bi bu be bo'],
  ['ぱぴぷぺぽ', 'pa pi pu pe po'],
  ['ぁぃぅぇぉ', 'a i u e o'],
  ['ゔ', 'vu'],
];

const SYLLABLES = new Map<string, string>(
  ROWS.flatMap(([kana, romaji]) => {
    const r = romaji.split(' ');
    return [...kana].map((k, i): [string, string] => [k, r[i]]);
  }),
);

const SMALL_Y: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o' };

/** きゃ → kya, しゃ → sha, ちょ → cho, じゅ → ju */
function yoon(base: string, vowel: string): string {
  const stem = base.slice(0, -1);
  return /(sh|ch|j)$/.test(stem) ? stem + vowel : `${stem}y${vowel}`;
}

export function kanaToRomaji(text: string): string {
  const chars = [...toHiragana(text)];
  const out: string[] = [];
  let doubleNext = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === 'っ') {
      doubleNext = true;
      continue;
    }
    if (c === 'ー') {
      const prev = out[out.length - 1];
      if (prev) out.push(prev.slice(-1));
      continue;
    }
    let syllable = SYLLABLES.get(c);
    if (syllable === undefined) {
      out.push(c);
      doubleNext = false;
      continue;
    }
    const small = SMALL_Y[chars[i + 1]];
    if (small && syllable.endsWith('i') && syllable.length > 1) {
      syllable = yoon(syllable, small);
      i++;
    }
    if (doubleNext) {
      syllable = (syllable.startsWith('ch') ? 't' : syllable[0]) + syllable;
      doubleNext = false;
    }
    out.push(syllable);
  }
  return out.join('');
}
