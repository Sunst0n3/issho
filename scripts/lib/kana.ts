// The kana course: hiragana then katakana, each as basic rows → dakuten/handakuten → yōon.

import type { KanaEntry, KanaKind } from '../../src/lib/types.ts';

/** [kana, Hepburn romaji, other accepted spellings] */
type KanaDef = [string, string, string[]?];
type Row = { group: string; kind: KanaKind; kana: KanaDef[] };

const BASIC: Row[] = [
  { group: 'a', kind: 'basic', kana: [['あ', 'a'], ['い', 'i'], ['う', 'u'], ['え', 'e'], ['お', 'o']] },
  { group: 'ka', kind: 'basic', kana: [['か', 'ka'], ['き', 'ki'], ['く', 'ku'], ['け', 'ke'], ['こ', 'ko']] },
  { group: 'sa', kind: 'basic', kana: [['さ', 'sa'], ['し', 'shi', ['si']], ['す', 'su'], ['せ', 'se'], ['そ', 'so']] },
  { group: 'ta', kind: 'basic', kana: [['た', 'ta'], ['ち', 'chi', ['ti']], ['つ', 'tsu', ['tu']], ['て', 'te'], ['と', 'to']] },
  { group: 'na', kind: 'basic', kana: [['な', 'na'], ['に', 'ni'], ['ぬ', 'nu'], ['ね', 'ne'], ['の', 'no']] },
  { group: 'ha', kind: 'basic', kana: [['は', 'ha'], ['ひ', 'hi'], ['ふ', 'fu', ['hu']], ['へ', 'he'], ['ほ', 'ho']] },
  { group: 'ma', kind: 'basic', kana: [['ま', 'ma'], ['み', 'mi'], ['む', 'mu'], ['め', 'me'], ['も', 'mo']] },
  { group: 'ya', kind: 'basic', kana: [['や', 'ya'], ['ゆ', 'yu'], ['よ', 'yo']] },
  { group: 'ra', kind: 'basic', kana: [['ら', 'ra'], ['り', 'ri'], ['る', 'ru'], ['れ', 're'], ['ろ', 'ro']] },
  // を is taught as "wo" so it never shares an answer with お; "o" is still accepted.
  { group: 'wa', kind: 'basic', kana: [['わ', 'wa'], ['を', 'wo', ['o']]] },
  { group: 'n', kind: 'basic', kana: [['ん', 'n', ['nn']]] },
];

const VOICED: Row[] = [
  { group: 'ga', kind: 'dakuten', kana: [['が', 'ga'], ['ぎ', 'gi'], ['ぐ', 'gu'], ['げ', 'ge'], ['ご', 'go']] },
  { group: 'za', kind: 'dakuten', kana: [['ざ', 'za'], ['じ', 'ji', ['zi']], ['ず', 'zu'], ['ぜ', 'ze'], ['ぞ', 'zo']] },
  { group: 'da', kind: 'dakuten', kana: [['だ', 'da'], ['ぢ', 'ji', ['di']], ['づ', 'zu', ['du']], ['で', 'de'], ['ど', 'do']] },
  { group: 'ba', kind: 'dakuten', kana: [['ば', 'ba'], ['び', 'bi'], ['ぶ', 'bu'], ['べ', 'be'], ['ぼ', 'bo']] },
  { group: 'pa', kind: 'handakuten', kana: [['ぱ', 'pa'], ['ぴ', 'pi'], ['ぷ', 'pu'], ['ぺ', 'pe'], ['ぽ', 'po']] },
];

/** Yōon rows: [group, i-row kana, Hepburn consonant, alternative consonants]. */
const YOON_BASES: [string, string, string, string[]][] = [
  ['kya', 'き', 'ky', []],
  ['sha', 'し', 'sh', ['sy']],
  ['cha', 'ち', 'ch', ['ty', 'cy']],
  ['nya', 'に', 'ny', []],
  ['hya', 'ひ', 'hy', []],
  ['mya', 'み', 'my', []],
  ['rya', 'り', 'ry', []],
  ['gya', 'ぎ', 'gy', []],
  ['ja', 'じ', 'j', ['zy', 'jy']],
  ['bya', 'び', 'by', []],
  ['pya', 'ぴ', 'py', []],
];

const YOON: Row[] = YOON_BASES.map(([group, base, consonant, alts]) => ({
  group,
  kind: 'yoon',
  kana: (['ゃ', 'ゅ', 'ょ'] as const).map((small, i): KanaDef => {
    const vowel = 'auo'[i];
    return [base + small, consonant + vowel, alts.map((c) => c + vowel)];
  }),
}));

const ROWS: Row[] = [...BASIC, ...VOICED, ...YOON];

const HIRAGANA_TO_KATAKANA = 0x60;

export function toKatakana(hiragana: string): string {
  return [...hiragana]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x3041 && cp <= 0x3096 ? String.fromCodePoint(cp + HIRAGANA_TO_KATAKANA) : ch;
    })
    .join('');
}

/** kana.json: every kana in teaching order. */
export function buildKanaTable(): KanaEntry[] {
  const out: KanaEntry[] = [];
  for (const script of ['hiragana', 'katakana'] as const) {
    for (const row of ROWS) {
      for (const [hira, romaji, alt] of row.kana) {
        const entry: KanaEntry = {
          char: script === 'hiragana' ? hira : toKatakana(hira),
          script,
          romaji,
          group: row.group,
          kind: row.kind,
          order: out.length,
        };
        if (alt && alt.length > 0) entry.altRomaji = alt;
        out.push(entry);
      }
    }
  }
  return out;
}

/** Every kana whose stroke paths are worth shipping: both scripts incl. small kana, plus ー. */
export function isStrokeKana(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x3041 && cp <= 0x3096) || (cp >= 0x30a1 && cp <= 0x30fa) || cp === 0x30fc;
}
