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
 * Drops dictionary-housekeeping meanings such as "one radical (no.1)" or
 * "(kokuji)". Clarifying parentheticals like "spring (season)" are kept.
 */
export function cleanKanjiMeanings(meanings: string[]): string[] {
  const out: string[] = [];
  for (const m of meanings) {
    if (/\bradical\b/i.test(m) || /^\(.*\)$/.test(m)) continue;
    if (!out.includes(m)) out.push(m);
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
              meanings: cleanKanjiMeanings(meanings),
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
