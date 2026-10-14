// Reading checks for authored content: how kanji readings combine inside a
// word, number + counter readings, and the full JMdict reading index used by
// check-content and the content tests (never shipped to the app).

import { readJMdict } from './jmdict.ts';

export const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCodePoint(ch.codePointAt(0)! - 0x60));

const VOICED: Readonly<Record<string, string>> = {
  か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ',
  た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ',
};
const SEMI_VOICED: Readonly<Record<string, string>> = { は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ' };
/** Final kana that turn into っ before a consonant: いち → いっ, じゅう → じゅっ. */
const GEMINATING_RE = /[つちくきう]$/;

/**
 * A reading as it may sound inside a word: its first kana voiced (rendaku:
 * ほん → ぼん, ぽん) and its last one turned into っ (いち → いっ).
 */
export function soundVariants(reading: string): string[] {
  const out = new Set([reading]);
  const [first = '', ...rest] = reading;
  const tail = rest.join('');
  if (VOICED[first]) out.add(VOICED[first] + tail);
  if (SEMI_VOICED[first]) out.add(SEMI_VOICED[first] + tail);
  for (const v of [...out]) if (v.length > 1 && GEMINATING_RE.test(v)) out.add(v.slice(0, -1) + 'っ');
  return [...out];
}

/** Whether `reading` is one candidate from each part, in order: ['さん'] + ['じゅっ'] + ['ぷん']. */
export function composesReading(parts: readonly (readonly string[])[], reading: string): boolean {
  const failed = new Set<string>();
  const from = (part: number, at: number): boolean => {
    if (part === parts.length) return at === reading.length;
    const key = `${part}:${at}`;
    if (failed.has(key)) return false;
    for (const option of parts[part]) {
      if (option && reading.startsWith(option, at) && from(part + 1, at + option.length)) return true;
    }
    failed.add(key);
    return false;
  };
  return from(0, 0);
}

const NUMERALS: Readonly<Record<string, readonly string[]>> = {
  一: ['いち'], 二: ['に'], 三: ['さん'], 四: ['よん'], 五: ['ご'], 六: ['ろく'], 七: ['なな', 'しち'],
  八: ['はち'], 九: ['きゅう'], 十: ['じゅう', 'じっ'], 百: ['ひゃく'], 千: ['せん'], 万: ['まん'], 何: ['なん'],
};

/** Common counters and the units read like them. Irregular forms (一人 ひとり, 二日 ふつか) are JMdict words. */
const COUNTERS: Readonly<Record<string, readonly string[]>> = {
  分: ['ふん'], 分間: ['ふんかん'], 秒: ['びょう'], 時: ['じ'], 時間: ['じかん'], 日: ['にち'],
  日間: ['にちかん'], 週間: ['しゅうかん'], 月: ['がつ', 'げつ'], 年: ['ねん'], 年間: ['ねんかん'],
  歳: ['さい'], 才: ['さい'], 回: ['かい'], 度: ['ど'], 階: ['かい'], 番: ['ばん'], 番目: ['ばんめ'],
  人: ['にん'], 本: ['ほん'], 枚: ['まい'], 冊: ['さつ'], 個: ['こ'], 匹: ['ひき'], 頭: ['とう'],
  羽: ['わ'], 台: ['だい'], 杯: ['はい'], 足: ['そく'], 着: ['ちゃく'], 軒: ['けん'], 件: ['けん'],
  点: ['てん'], 円: ['えん'], 泊: ['はく'], 名: ['めい'], 号: ['ごう'], 歩: ['ほ'], 曲: ['きょく'],
};

/** How the numeral right before these counters is read: 四時 よじ, 九時 くじ, 四月 しがつ, 四人 よにん. */
const BEFORE_COUNTER: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  時: { 四: ['よ'], 九: ['く'] },
  時間: { 四: ['よ'], 九: ['く'] },
  月: { 四: ['し'], 七: ['しち'], 九: ['く'] },
  人: { 四: ['よ'], 九: ['きゅう', 'く'] },
  年: { 四: ['よ'], 九: ['きゅう', 'く'] },
  年間: { 四: ['よ'], 九: ['きゅう', 'く'] },
  円: { 四: ['よ'] },
  日: { 四: ['よっ'], 七: ['しち'], 九: ['く'] },
  日間: { 四: ['よっ'], 七: ['しち'], 九: ['く'] },
};
/** Days 2–10 and 20 are native words (ふつか … とおか, はつか) that JMdict lists; 14 and 24 end in よっか. */
const NATIVE_DAYS = new Set(['二', '三', '四', '五', '六', '七', '八', '九', '十', '二十']);
const DAY_AFTER_FOUR: Readonly<Record<string, string>> = { 日: 'か', 日間: 'かかん' };

const NUMBER_COUNTER_RE = /^([一二三四五六七八九十百千万何]+)(.+)$/;
/** 一 and 十 always become いっ and じゅっ before a counter starting with k, s, t or h (which turns into p). */
const GEMINATED: Readonly<Record<string, readonly string[]>> = { 一: ['いっ'], 十: ['じゅっ', 'じっ'] };
const VOICELESS_RE = /^[かきくけこさしすせそたちつてとはひふへほ]/;

/**
 * Whether `written` is a number with a counter (五分, 三十分, 一本, 何時) and
 * `reading` reads it with the usual sound changes: ごふん, さんじゅっぷん,
 * いっぽん, なんじ. The numeral before the counter must take its set form
 * (四時 よじ, not よんじ; 十四日 じゅうよっか), and 一 and 十 must become いっ and
 * じゅっ (いちほん is wrong); the other sound changes vary by counter and are
 * accepted either way. Days 2–10 and 20 are left to the dictionary, except
 * at the end of a range (`endsRange`): 二、三日 is にさんにち.
 */
export function isCounterReading(written: string, reading: string, endsRange = false): boolean {
  const m = NUMBER_COUNTER_RE.exec(written);
  const [number, counter] = m ? [m[1], m[2]] : ['', ''];
  const isDay = counter in DAY_AFTER_FOUR;
  if (!COUNTERS[counter] || (isDay && !endsRange && NATIVE_DAYS.has(number))) return false;
  const numerals = [...number];
  const last = numerals[numerals.length - 1];
  const kana = toHiragana(reading);
  const lastNumeral = BEFORE_COUNTER[counter]?.[last] ?? NUMERALS[last];
  const counterReadings = isDay && last === '四' ? [DAY_AFTER_FOUR[counter]] : COUNTERS[counter];
  return counterReadings.some((counterKana) => {
    const forced = last in GEMINATED && VOICELESS_RE.test(counterKana);
    const parts = numerals.map((ch, i) => {
      if (i < numerals.length - 1) return NUMERALS[ch].flatMap(soundVariants);
      return forced ? GEMINATED[ch] : lastNumeral.flatMap(soundVariants);
    });
    const semiVoiced = SEMI_VOICED[counterKana[0]];
    parts.push(forced ? [semiVoiced ? semiVoiced + counterKana.slice(1) : counterKana] : soundVariants(counterKana));
    return composesReading(parts, kana);
  });
}

export interface JmdictReadings {
  /** Every spelling → its entries' regular readings, in hiragana. */
  byWritten: Map<string, string[]>;
  /** Every regular reading of every entry, as written in JMdict. */
  kana: Set<string>;
}

/** Readings that are not how the word is read: irregular, outdated, rare or search-only kana. */
const IRREGULAR_READING = new Set(['ik', 'ok', 'rk', 'sk']);

/**
 * All of JMdict's readings by spelling. words.json keeps one reading per word
 * (明日 あした), so content checked against it alone flags valid readings
 * (明日 みょうにち, 家 うち); this index has every regular reading of every
 * entry that uses the spelling.
 */
export async function readJmdictReadings(path: string): Promise<JmdictReadings> {
  const byWritten = new Map<string, Set<string>>();
  const kana = new Set<string>();
  await readJMdict(path, (e) => {
    const readings = e.readings.filter((r) => !r.noKanji && !r.info.some((i) => IRREGULAR_READING.has(i)));
    for (const r of e.readings) if (!r.info.some((i) => IRREGULAR_READING.has(i))) kana.add(r.text);
    for (const k of e.kanji) {
      let set = byWritten.get(k.text);
      if (!set) byWritten.set(k.text, (set = new Set()));
      for (const r of readings) set.add(toHiragana(r.text));
    }
  });
  return { byWritten: new Map([...byWritten].map(([k, v]) => [k, [...v]])), kana };
}
