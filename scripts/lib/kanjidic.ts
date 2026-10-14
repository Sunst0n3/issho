// KANJIDIC2: readings, meanings and frequency data for the jōyō kanji.

import { parseXmlGz } from './xml.ts';

export interface KanjidicEntry {
  char: string;
  meanings: string[];
  on: string[];
  kun: string[];
  strokeCount: number;
  grade?: number;
  jlptOld?: number;
  freq?: number;
}

const MAX_MEANINGS = 4;

/** KANJIDIC2 grades 1–6 are kyōiku kanji and 8 the rest of the jōyō list. */
export function isJoyoGrade(grade: number | undefined): boolean {
  return grade !== undefined && grade >= 1 && grade <= 8;
}

/** Strips KANJIDIC's prefix/suffix hyphens ('みず-', '-ジ') and removes duplicates. */
export function cleanReadings(readings: string[]): string[] {
  return [...new Set(readings.map((r) => r.replace(/-/g, '')).filter(Boolean))];
}

const ON_RE = /^[ァ-ヺー]+$/;
const KUN_RE = /^[ぁ-ゖー.]+$/;

/** On readings in katakana, cleaned. */
export function onReadings(readings: string[]): string[] {
  return cleanReadings(readings).filter((r) => ON_RE.test(r));
}

/**
 * Kun readings in hiragana, cleaned. KANJIDIC also files a few unit
 * abbreviations as katakana kun readings (志 シリング "shilling", 粉 デシメートル);
 * they are not readings of the kanji and are dropped.
 */
export function kunReadings(readings: string[]): string[] {
  return cleanReadings(readings).filter((r) => KUN_RE.test(r));
}

/**
 * Glosses replaced by the plain word a learner would type. KANJIDIC writes
 * powers of ten as '10**16'; the ones without an everyday English name
 * (10**32 and up) are left to be dropped with the other numeric glosses.
 */
const GLOSS_REWRITES: Readonly<Record<string, string>> = {
  '10**8': 'hundred million',
  '10**12': 'trillion',
  '10**16': 'ten quadrillion',
  '%': 'percent',
  'Inst.': 'institution',
  'No.': 'number (ordinal)',
  'pass thru': 'pass through',
  'road-way': 'road',
};

/** A parenthetical holding arithmetic or a measure: "product (x*y)", "second (1/60 minute)". */
const NUMERIC_NOTE_RE = /\s*\([^()]*[\d*/][^()]*\)/g;

/**
 * Hand-checked first meanings for common kanji whose KANJIDIC list opens with
 * a rare or bookish sense: a learner meets 校 as "school", not "exam", and 着
 * as "wear", not "don". Lessons and write prompts name a kanji by its first
 * meaning, so none of these may be another early kanji's first meaning: 用
 * stays "utilize" beside 使 "use", 世 "generation" beside 界 "world", 経
 * "sutra" beside 通 "pass through", and 里 is the "home village" next to 村.
 */
export const LEAD_MEANINGS: Readonly<Record<string, string>> = {
  校: 'school',
  回: 'times',
  介: 'mediate',
  由: 'reason',
  画: 'picture',
  着: 'wear',
  機: 'machine',
  話: 'talk',
  語: 'language',
  里: 'home village',
  通: 'pass through',
  計: 'measure',
  私: 'I',
  未: 'not yet',
  仕: 'serve',
  更: 'renew',
  対: 'opposite',
  堂: 'hall',
  起: 'wake up',
};

/** Compares glosses the way answers are checked: "-times" = "times", "a reason" = "reason". */
const meaningKey = (m: string) =>
  m
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .replace(/^(a|an|the|to) /, '');

/**
 * Tidies KANJIDIC's English meanings for quizzes. Drops dictionary
 * housekeeping ("one radical (no.1)", "(kokuji)"), hours of the zodiac
 * ("11PM-1AM"), units and other numeric glosses ("1.32 lb", "0.1"); rewrites
 * symbols and abbreviations ('%' → "percent", "Inst." → "institution",
 * '10**16' → "ten quadrillion", "&" → "and") and strips arithmetic notes
 * ("product (x*y)" → "product"). Clarifying parentheticals like
 * "spring (season)" are kept. Near-duplicates ("a light" and "light",
 * "-times" and "times") keep the shorter spelling. `lead`, when given,
 * becomes the first meaning.
 */
export function cleanKanjiMeanings(meanings: string[], lead?: string): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    const key = meaningKey(m);
    const at = out.findIndex((o) => meaningKey(o) === key);
    if (at < 0) out.push(m);
    else if (m.length < out[at].length) out[at] = m;
  };
  if (lead) add(lead);
  for (const raw of meanings) {
    if (/\bradical\b/i.test(raw) || /^\(.*\)$/.test(raw)) continue;
    const m = (GLOSS_REWRITES[raw] ?? raw).replace(/ & /g, ' and ').replace(NUMERIC_NOTE_RE, '').trim();
    if (!m || /\d/.test(m)) continue;
    add(m);
  }
  return out.slice(0, MAX_MEANINGS);
}

/** Reads every jōyō kanji (grade 1–8) from kanjidic2.xml.gz. */
export async function readKanjidic(path: string): Promise<Map<string, KanjidicEntry>> {
  const out = new Map<string, KanjidicEntry>();
  let text = '';
  let rType = '';
  let mLang: string | undefined;
  let literal = '';
  let grade: number | undefined;
  let strokeCounts: number[] = [];
  let freq: number | undefined;
  let jlpt: number | undefined;
  let on: string[] = [];
  let kun: string[] = [];
  let meanings: string[] = [];

  await parseXmlGz(path, {
    onopentag(tag) {
      text = '';
      if (tag.name === 'character') {
        literal = '';
        grade = freq = jlpt = undefined;
        strokeCounts = [];
        on = [];
        kun = [];
        meanings = [];
      } else if (tag.name === 'reading') {
        rType = tag.attributes.r_type ?? '';
      } else if (tag.name === 'meaning') {
        mLang = tag.attributes.m_lang;
      }
    },
    ontext(t) {
      text += t;
    },
    onclosetag(name) {
      switch (name) {
        case 'literal': literal = text; break;
        case 'grade': grade = Number(text); break;
        case 'stroke_count': strokeCounts.push(Number(text)); break;
        case 'freq': freq = Number(text); break;
        case 'jlpt': jlpt = Number(text); break;
        case 'reading':
          if (rType === 'ja_on') on.push(text);
          else if (rType === 'ja_kun') kun.push(text);
          break;
        case 'meaning':
          if (!mLang) meanings.push(text);
          break;
        case 'character':
          if (isJoyoGrade(grade)) {
            out.set(literal, {
              char: literal,
              meanings: cleanKanjiMeanings(meanings, LEAD_MEANINGS[literal]),
              on: onReadings(on),
              kun: kunReadings(kun),
              // The first stroke count is the accepted one; later ones are common miscounts.
              strokeCount: strokeCounts[0] ?? 0,
              grade,
              jlptOld: jlpt,
              freq,
            });
          }
          break;
      }
    },
  });
  return out;
}
