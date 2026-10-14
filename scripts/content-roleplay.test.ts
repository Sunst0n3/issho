// @vitest-environment node
// Regression checks for content/survival-words.json and content/roleplays.json,
// from the content review: recall-card ambiguity, punctuation and spacing per
// level, register in the couple's scenes, and dictionary checks on every
// reading. The dictionary checks need data-raw/JMdict_e.gz and public/data and
// skip without them.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isKanaOnly, isKanji, kanjiIn, parseRuby, rubyToKana, rubyToPlain, validateRuby } from '../src/lib/ruby.ts';
import type { KanjiEntry, RolePlay, SurvivalWord } from '../src/lib/types.ts';
import { composesReading, readJmdictReadings, soundVariants, toHiragana, type JmdictReadings } from './lib/readings.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const JMDICT = `${ROOT}data-raw/JMdict_e.gz`;
const KANJI = `${ROOT}public/data/kanji.json`;

const survival = read<SurvivalWord[]>('content/survival-words.json');
const roleplays = read<RolePlay[]>('content/roleplays.json');

/** Everyday English near-synonyms a learner cannot tell apart on a recall card. */
const SYNONYMS: [RegExp, string][] = [
  [/\b(yeah|yep)\b/g, 'yes'],
  [/\b(nope|nah)\b/g, 'no'],
  [/\bpleased\b/g, 'nice'],
  [/\b(okay|alright|all right|fine)\b/g, 'ok'],
  [/\bthank you\b/g, 'thanks'],
  [/\b(good-?bye)\b/g, 'bye'],
  [/\bhi\b/g, 'hello'],
];

/** One "; "-separated gloss, folded to its meaning and its "(qualifier)". */
function glossKey(gloss: string): { base: string; qualifier: string } {
  const qualifier = [...gloss.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim().toLowerCase()).join(',');
  let base = gloss
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[!?.,"]/g, '')
    .replace(/^(to|a|an|the) /, '')
    .trim();
  for (const [re, to] of SYNONYMS) base = base.replace(re, to);
  return { base, qualifier };
}

/** Partners talk casually; the couple's scenes are played by these two. */
const COUPLE = new Set(['ひかる', 'あおい']);

/** Every Japanese text of a role-play, with where it is. */
const textsOf = (rp: RolePlay): [string, string][] => [
  ['titleJp', rp.titleJp],
  ['roles.a.nameJp', rp.roles.a.nameJp],
  ['roles.b.nameJp', rp.roles.b.nameJp],
  ...rp.lines.map((l, i): [string, string] => [`lines[${i}]`, l.jp]),
];

describe('content/survival-words.json', () => {
  it('has well-formed, unique entries', () => {
    const seen = { id: new Set<string>(), kana: new Set<string>(), en: new Set<string>() };
    for (const w of survival) {
      expect(Object.keys(w).filter((k) => !['id', 'kana', 'written', 'en', 'note'].includes(k)), w.id).toEqual([]);
      expect(w.id).toMatch(/^sw-[a-z]+$/);
      expect(isKanaOnly(w.kana) && !/\s/.test(w.kana), `${w.id}: kana "${w.kana}"`).toBe(true);
      expect(w.en.trim(), w.id).not.toBe('');
      for (const key of ['id', 'kana', 'en'] as const) {
        expect(seen[key].has(w[key]), `${w.id}: duplicate ${key}`).toBe(false);
        seen[key].add(w[key]);
      }
      // Notes are read during the kana phase, before any kanji is taught.
      if (w.note) expect(kanjiIn(w.note), w.id).toEqual([]);
    }
  });

  it('never gives two words the same meaning without distinct qualifiers (ambiguous recall cards)', () => {
    const owners = new Map<string, { id: string; qualifier: string }[]>();
    const problems: string[] = [];
    for (const w of survival) {
      const glosses = new Map(w.en.split(';').map((g) => glossKey(g)).map((k) => [k.base, k]));
      for (const { base, qualifier } of glosses.values()) {
        if (!base) continue;
        const others = owners.get(base) ?? [];
        for (const o of others) {
          if (!qualifier || !o.qualifier || qualifier === o.qualifier) problems.push(`${w.id} and ${o.id} both mean "${base}"`);
        }
        owners.set(base, [...others, { id: w.id, qualifier }]);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('content/roleplays.json', () => {
  it('has 14 scenes: 6 at level 1, 5 at level 2 and 3 at level 3', () => {
    expect(new Set(roleplays.map((rp) => rp.id)).size).toBe(roleplays.length);
    const byLevel = (level: number) => roleplays.filter((rp) => rp.level === level).length;
    expect([byLevel(1), byLevel(2), byLevel(3)]).toEqual([6, 5, 3]);
  });

  it('gives every scene 12–14 well-formed lines', () => {
    for (const rp of roleplays) {
      for (const key of ['id', 'title', 'titleJp', 'level', 'setting', 'roles', 'lines'] as const) {
        expect(rp[key], `${rp.id}: ${key}`).toBeDefined();
      }
      expect(rp.lines.length, rp.id).toBeGreaterThanOrEqual(12);
      expect(rp.lines.length, rp.id).toBeLessThanOrEqual(14);
      rp.lines.forEach((l, i) => {
        const at = `${rp.id} line ${i}`;
        expect(['a', 'b'], at).toContain(l.role);
        expect(l.en.trim(), at).not.toBe('');
        expect(Object.keys(l).filter((k) => !['role', 'jp', 'en', 'hint'].includes(k)), at).toEqual([]);
        if (rp.level === 1 && l.hint) expect(kanjiIn(l.hint), `${at}: kanji in a level-1 hint`).toEqual([]);
      });
    }
  });

  it('writes Japanese the way each level reads it', () => {
    const problems: string[] = [];
    for (const rp of roleplays) {
      for (const [where, text] of textsOf(rp)) {
        const at = `${rp.id} ${where}`;
        for (const p of validateRuby(text)) problems.push(`${at}: ${p}`);
        const plain = rubyToPlain(text);
        if (/[A-Za-z0-9]/.test(plain)) problems.push(`${at}: Latin letters or digits in "${text}"`);
        if (/[!?,.;:()]/.test(plain)) problems.push(`${at}: half-width punctuation in "${text}"`);
        if (rp.level === 1 && kanjiIn(text).length > 0) problems.push(`${at}: kanji in a level-1 script`);
        // Word spacing is a level-1 reading aid; text with kanji is written without spaces.
        if (rp.level > 1 && /[ 　]/.test(plain)) problems.push(`${at}: spaces in a level-${rp.level} script`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the couple casual and family terms right between them', () => {
    const problems: string[] = [];
    for (const rp of roleplays.filter((r) => COUPLE.has(r.roles.a.nameJp) && COUPLE.has(r.roles.b.nameJp))) {
      rp.lines.forEach((l, i) => {
        const at = `${rp.id} lines[${i}]`;
        if (/(です|ます|でした|ました|ません)[。！？…]*$/.test(rubyToKana(l.jp).replace(/\s/g, ''))) {
          problems.push(`${at}: polite ending between partners: "${l.jp}"`);
        }
        // はは/ちち are for outsiders; to a partner your parents are おかあさん/おとうさん.
        const outsider = parseRuby(l.jp).some(
          (s) => /^(はは|ちち)$/.test(s.reading ?? '') || /(^|[^お])(はは|ちち)に/.test(s.text),
        );
        if (outsider) problems.push(`${at}: outsider family term between partners: "${l.jp}"`);
      });
    }
    expect(problems).toEqual([]);
  });
});

/** Readings a native speaker accepts that the dictionaries cannot derive, each checked by hand. */
const READING_ALLOW = new Set([
  '今日|きょう', '昨日|きのう', '明日|あした', '風邪|かぜ', '果物|くだもの', '大人|おとな',
  // お{母|かあ}さん, お{父|とう}さん: the jōyō special readings of 母さん and 父さん.
  '母|かあ', '父|とう',
]);

/** Conjugated forms and phrases that are not dictionary headwords, checked by hand. */
const SURVIVAL_NOT_HEADWORD = new Set([
  'わかりません', 'わかりました', 'つかれた', 'あいしてる', 'がんばって', 'おねがいします',
  'よろしくおねがいします', 'もういちど', 'そうですか',
]);

describe.skipIf(!existsSync(JMDICT) || !existsSync(KANJI))('survival words and role-plays against the dictionaries', () => {
  let jmdict: JmdictReadings;
  let kanji: Record<string, KanjiEntry>;
  beforeAll(async () => {
    jmdict = await readJmdictReadings(JMDICT);
    kanji = read<Record<string, KanjiEntry>>('public/data/kanji.json');
  }, 60_000);

  /** A kanji's KANJIDIC readings in hiragana: on, kun stems and kun with okurigana. */
  const kanjiReadings = (ch: string) =>
    (kanji[ch] ? [...kanji[ch].on, ...kanji[ch].kun.flatMap((k) => [k.split('.')[0], k.replace('.', '')])] : []).map(
      toHiragana,
    );

  /** Whether each character of `base` can take one of its readings (with sound changes) to spell `reading`. */
  const composes = (base: string, reading: string) => {
    const chars = [...base];
    const parts = chars.map((ch, i) => {
      if (ch === '々' && i > 0) return kanjiReadings(chars[i - 1]).flatMap(soundVariants);
      return isKanji(ch) ? kanjiReadings(ch).flatMap(soundVariants) : [toHiragana(ch)];
    });
    return composesReading(parts, toHiragana(reading));
  };

  const readsAs = (base: string, reading: string) =>
    READING_ALLOW.has(`${base}|${reading}`) ||
    (jmdict.byWritten.get(base)?.includes(toHiragana(reading)) ?? false) ||
    composes(base, reading);

  it('spells every survival word as a dictionary reading, and its kanji form reads as it', () => {
    const problems: string[] = [];
    for (const w of survival) {
      if (!jmdict.kana.has(w.kana) && !SURVIVAL_NOT_HEADWORD.has(w.kana)) problems.push(`${w.id}: "${w.kana}" is not a JMdict reading`);
      if (w.written === undefined) continue;
      const chars = [...w.written].filter(isKanji);
      if (chars.length === 0) problems.push(`${w.id}: "${w.written}" has no kanji`);
      for (const ch of chars) if (!(ch in kanji)) problems.push(`${w.id}: ${ch} is not a jōyō kanji`);
      if (!readsAs(w.written, w.kana)) problems.push(`${w.id}: "${w.written}" does not read as "${w.kana}"`);
    }
    expect(problems).toEqual([]);
  });

  it('uses jōyō kanji with readings JMdict or KANJIDIC support in every role-play', () => {
    const problems: string[] = [];
    for (const rp of roleplays) {
      for (const [where, text] of textsOf(rp)) {
        for (const ch of kanjiIn(text)) if (!(ch in kanji)) problems.push(`${rp.id} ${where}: ${ch} is not a jōyō kanji`);
        for (const seg of parseRuby(text)) {
          if (seg.reading !== undefined && !readsAs(seg.text, seg.reading)) {
            problems.push(`${rp.id} ${where}: {${seg.text}|${seg.reading}} is not supported by JMdict or KANJIDIC`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
