// Numbers, prices, times and counters (pure): readings with their sound changes,
// and a drill made only of material whose grammar the learner was taught.

export type NumberDrillKind = 'number' | 'price' | 'time' | 'counter';
export interface NumberDrillItem { kind: NumberDrillKind; prompt: string; answers: string[] }

const ONES = ['', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
const TENS = ['', 'じゅう', 'にじゅう', 'さんじゅう', 'よんじゅう', 'ごじゅう', 'ろくじゅう', 'ななじゅう', 'はちじゅう', 'きゅうじゅう'];
const HUNDREDS = ['', 'ひゃく', 'にひゃく', 'さんびゃく', 'よんひゃく', 'ごひゃく', 'ろっぴゃく', 'ななひゃく', 'はっぴゃく', 'きゅうひゃく'];
const THOUSANDS = ['', 'せん', 'にせん', 'さんぜん', 'よんせん', 'ごせん', 'ろくせん', 'ななせん', 'はっせん', 'きゅうせん'];

export const MAX_NUMBER = 99_999_999;

/** 1..9999 in kana; `beforeMan`: 1000 before 万 is いっせん. */
function readUnder10000(n: number, beforeMan = false): string {
  const th = Math.floor(n / 1000);
  const h = Math.floor(n / 100) % 10;
  const t = Math.floor(n / 10) % 10;
  const o = n % 10;
  const thousands = th === 1 && beforeMan ? 'いっせん' : THOUSANDS[th];
  return thousands + HUNDREDS[h] + TENS[t] + ONES[o];
}

/**
 * Hiragana reading of 0..99,999,999 with sound changes: 三百 さんびゃく, 六百 ろっぴゃく, 八百 はっぴゃく,
 * 三千 さんぜん, 八千 はっせん, 一万 いちまん, 十 じゅう.
 */
export function readNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > MAX_NUMBER) throw new RangeError(`Cannot read ${n}`);
  if (n === 0) return 'ぜろ';
  const man = Math.floor(n / 10_000);
  const rest = n % 10_000;
  return (man ? readUnder10000(man, true) + 'まん' : '') + (rest ? readUnder10000(rest) : '');
}

/** readNumber + えん (4 yen is よえん). */
export function readPrice(yen: number): string {
  const n = readNumber(yen);
  return yen % 10 === 4 ? `${n.slice(0, -2)}よえん` : `${n}えん`;
}

/** Hour readings: 4時 よじ, 7時 しちじ, 9時 くじ (0 is れいじ). */
function readHour(h: number): string {
  if (h === 0) return 'れいじ';
  const base = readNumber(h);
  const o = h % 10;
  if (o === 4) return `${base.slice(0, -2)}よじ`;
  if (o === 7) return `${base.slice(0, -2)}しちじ`;
  if (o === 9) return `${base.slice(0, -3)}くじ`;
  return `${base}じ`;
}

/** Minute readings of 1..9 (ふん/ぷん) and of a whole ten. */
const MINUTE_ONES: string[][] = [
  [],
  ['いっぷん'],
  ['にふん'],
  ['さんぷん'],
  ['よんぷん'],
  ['ごふん'],
  ['ろっぷん'],
  ['ななふん'],
  ['はっぷん', 'はちふん'],
  ['きゅうふん'],
];

function readMinutes(m: number): string[] {
  const t = Math.floor(m / 10);
  const o = m % 10;
  if (o) return MINUTE_ONES[o].map((r) => TENS[t] + r);
  const prefix = TENS[t].slice(0, -'じゅう'.length);
  return [`${prefix}じゅっぷん`, `${prefix}じっぷん`];
}

/**
 * 4時 よじ, 7時 しちじ, 9時 くじ; minutes: いっぷん, にふん, さんぷん, よんぷん, ごふん, ろっぷん, ななふん, はっぷん/はちふん,
 * きゅうふん, じゅっぷん/じっぷん; 30 → はん also accepted.
 */
export function readTime(h: number, m: number): string[] {
  if (!Number.isInteger(h) || h < 0 || h > 24 || !Number.isInteger(m) || m < 0 || m > 59) throw new RangeError(`Cannot read ${h}:${m}`);
  const hour = readHour(h);
  if (m === 0) return [hour];
  const minutes = readMinutes(m).map((r) => hour + r);
  return m === 30 ? [...minutes, `${hour}はん`] : minutes;
}

export type Counter = 'つ' | '人' | '枚' | '本' | '杯' | '匹' | '個' | '回';
export const COUNTERS: readonly Counter[] = ['つ', '人', '枚', '本', '杯', '匹', '個', '回'];

/** Grammar id that must be introduced before a counter, time or price item is drilled ("only known material"). */
export const NUMBER_DRILL_GRAMMAR = {
  prices: 'numbers-prices',
  time: 'time-telling',
  counters: {
    つ: 'counting-tsu',
    人: 'counters-people',
    枚: 'counters-objects',
    本: 'counters-objects',
    杯: 'counters-objects',
    匹: 'counters-objects',
    個: 'counters-objects',
    回: 'counters-objects',
  },
} as const satisfies { prices: 'numbers-prices'; time: 'time-telling'; counters: Record<Counter, string> };

const TSU = ['', 'ひとつ', 'ふたつ', 'みっつ', 'よっつ', 'いつつ', 'むっつ', 'ななつ', 'やっつ', 'ここのつ', 'とお'];

/** Counters with sound changes, 1..10 (index), each with its accepted readings. */
const SOUND_CHANGE: Record<'本' | '杯' | '匹' | '個' | '回', string[][]> = {
  本: [[], ['いっぽん'], ['にほん'], ['さんぼん'], ['よんほん'], ['ごほん'], ['ろっぽん'], ['ななほん'], ['はっぽん', 'はちほん'], ['きゅうほん'], ['じゅっぽん', 'じっぽん']],
  杯: [[], ['いっぱい'], ['にはい'], ['さんばい'], ['よんはい'], ['ごはい'], ['ろっぱい'], ['ななはい'], ['はっぱい', 'はちはい'], ['きゅうはい'], ['じゅっぱい', 'じっぱい']],
  匹: [[], ['いっぴき'], ['にひき'], ['さんびき'], ['よんひき'], ['ごひき'], ['ろっぴき'], ['ななひき'], ['はっぴき', 'はちひき'], ['きゅうひき'], ['じゅっぴき', 'じっぴき']],
  個: [[], ['いっこ'], ['にこ'], ['さんこ'], ['よんこ'], ['ごこ'], ['ろっこ'], ['ななこ'], ['はっこ', 'はちこ'], ['きゅうこ'], ['じゅっこ', 'じっこ']],
  回: [[], ['いっかい'], ['にかい'], ['さんかい', 'さんがい'], ['よんかい'], ['ごかい'], ['ろっかい'], ['ななかい'], ['はっかい', 'はちかい'], ['きゅうかい'], ['じゅっかい', 'じっかい']],
};

/** Readings of n with a counter; n ≥ 1. */
export function readCounter(n: number, counter: Counter): string[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new RangeError(`Cannot count ${n}`);
  switch (counter) {
    case 'つ':
      return n <= 10 ? [TSU[n]] : [readNumber(n)];
    case '人':
      if (n === 1) return ['ひとり'];
      if (n === 2) return ['ふたり'];
      if (n % 10 === 4) return [`${readNumber(n).slice(0, -2)}よにん`];
      if (n % 10 === 7) return [`${readNumber(n)}にん`, `${readNumber(n).slice(0, -2)}しちにん`];
      if (n % 10 === 9) return [`${readNumber(n)}にん`, `${readNumber(n).slice(0, -3)}くにん`];
      return [`${readNumber(n)}にん`];
    case '枚':
      return [`${readNumber(n)}まい`];
    default: {
      const table = SOUND_CHANGE[counter];
      if (n <= 10) return table[n];
      const ones = n % 10;
      if (ones) return table[ones].map((r) => readNumber(n - ones) + r);
      // A whole ten above 10: …じゅう + the counter's 10 form (にじゅっぽん).
      const head = readNumber(n).slice(0, -'じゅう'.length);
      return table[10].map((r) => head + r);
    }
  }
}

function pickInt(random: () => number, from: number, to: number): number {
  return from + Math.floor(random() * (to - from + 1));
}

/** A number as shown in a prompt: 1,500. */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** pickFluency passes only the counters, time and prices whose NUMBER_DRILL_GRAMMAR id is introduced. */
export function numbersDrill(
  random: () => number,
  opts: { counters: Counter[]; time: boolean; prices: boolean; count?: number },
): NumberDrillItem[] {
  const count = opts.count ?? 10;
  const kinds: NumberDrillKind[] = ['number'];
  if (opts.prices) kinds.push('price');
  if (opts.time) kinds.push('time');
  if (opts.counters.length) kinds.push('counter');
  const items: NumberDrillItem[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length];
    switch (kind) {
      case 'number': {
        const digits = pickInt(random, 1, 5);
        const n = pickInt(random, digits === 1 ? 1 : 10 ** (digits - 1), 10 ** digits - 1);
        items.push({ kind, prompt: formatNumber(n), answers: [readNumber(n)] });
        break;
      }
      case 'price': {
        const yen = pickInt(random, 1, 99) * (random() < 0.5 ? 10 : 100);
        items.push({ kind, prompt: `¥${formatNumber(yen)}`, answers: [readPrice(yen)] });
        break;
      }
      case 'time': {
        const h = pickInt(random, 1, 12);
        const m = random() < 0.3 ? 0 : random() < 0.5 ? 30 : pickInt(random, 1, 59);
        items.push({ kind, prompt: `${h}:${String(m).padStart(2, '0')}`, answers: readTime(h, m) });
        break;
      }
      case 'counter': {
        const counter = opts.counters[pickInt(random, 0, opts.counters.length - 1)];
        const n = pickInt(random, 1, 10);
        items.push({ kind, prompt: `${n}${counter}`, answers: readCounter(n, counter) });
        break;
      }
    }
  }
  return items;
}
