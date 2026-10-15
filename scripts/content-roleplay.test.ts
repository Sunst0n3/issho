// @vitest-environment node
// Regression checks for the role-plays (content/roleplays-v2/: the 14 upgraded v1 scenes in
// legacy.json plus one core conversation per unit) and the survival core words, from the
// content reviews: recall-card ambiguity, punctuation and spacing, register in the couple's
// scenes, and dictionary checks on every reading. The dictionary checks need
// data-raw/JMdict_e.gz and public/data and skip without them.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isKanji, kanjiIn, parseRuby, rubyToKana, rubyToPlain, validateRuby } from '../src/lib/ruby.ts';
import type { CoreWord, KanjiEntry, RolePlay, UnitSpec } from '../src/lib/types.ts';
import { mergeContent, readContentSources } from './lib/content.ts';
import { castProblems } from './lib/cast.ts';
import { CORE_CONVERSATION_LINES, buildRolePlays } from './lib/roleplays.ts';
import { composesReading, readJmdictReadings, soundVariants, toHiragana, type JmdictReadings } from './lib/readings.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const JMDICT = `${ROOT}data-raw/JMdict_e.gz`;
const KANJI = `${ROOT}public/data/kanji.json`;
const content = <T,>(kind: Parameters<typeof readContentSources>[1]) =>
  mergeContent(kind, readContentSources(`${ROOT}content`, kind, ROOT).sources).data as T;

const rolePlays = content<RolePlay[]>('roleplays');
const units = content<UnitSpec[]>('units');
const core = content<CoreWord[]>('core-words');
const conversations = new Set(units.map((u) => u.conversation));
const legacy = rolePlays.filter((rp) => !conversations.has(rp.id));
const coreConversations = rolePlays.filter((rp) => conversations.has(rp.id));
const survival = core.filter((w) => w.survival);

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

describe('survival core words', () => {
  it('keep the 117 v1 survival words, with kana-only notes (read before any kanji is taught)', () => {
    expect(survival).toHaveLength(117);
    for (const w of survival) if (w.note) expect(kanjiIn(w.note), w.id).toEqual([]);
  });

  it('never give two survival words the same meaning without distinct qualifiers or registers (ambiguous recall cards)', () => {
    const owners = new Map<string, { id: string; qualifier: string; register: string }[]>();
    const problems: string[] = [];
    // A polite and a plain word are told apart by the card's register label (ありがとう / ありがとうございます).
    const sameRegister = (a: string, b: string) => a === b || a === 'both' || b === 'both';
    for (const w of survival) {
      const glosses = new Map(w.en.split(';').map((g) => glossKey(g)).map((k) => [k.base, k]));
      for (const { base, qualifier } of glosses.values()) {
        if (!base) continue;
        const others = owners.get(base) ?? [];
        for (const o of others) {
          const unqualified = !qualifier || !o.qualifier || qualifier === o.qualifier;
          if (unqualified && sameRegister(w.register, o.register)) problems.push(`${o.id}/${w.id} "${base}"`);
        }
        owners.set(base, [...others, { id: w.id, qualifier, register: w.register }]);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('content/roleplays-v2', () => {
  it('has the 14 upgraded scenes (6 at level 1, 5 at level 2, 3 at level 3) and one core conversation per unit', () => {
    expect(new Set(rolePlays.map((rp) => rp.id)).size).toBe(rolePlays.length);
    const byLevel = (level: number) => legacy.filter((rp) => rp.level === level).length;
    expect([byLevel(1), byLevel(2), byLevel(3)]).toEqual([6, 5, 3]);
    expect(coreConversations).toHaveLength(units.length);
  });

  it('gives the scenes 9–14 lines and the core conversations 4–8, every line well formed with a cue', () => {
    for (const rp of rolePlays) {
      const [min, max] = conversations.has(rp.id) ? [CORE_CONVERSATION_LINES.min, CORE_CONVERSATION_LINES.max] : [9, 14];
      expect(rp.lines.length, rp.id).toBeGreaterThanOrEqual(min);
      expect(rp.lines.length, rp.id).toBeLessThanOrEqual(max);
      expect(['polite', 'plain', 'mixed'], rp.id).toContain(rp.register);
      rp.lines.forEach((l, i) => {
        const at = `${rp.id} line ${i}`;
        expect(['a', 'b'], at).toContain(l.role);
        expect(l.en.trim(), at).not.toBe('');
        expect(l.cue.trim(), at).not.toBe('');
        expect(Object.keys(l).filter((k) => !['role', 'jp', 'en', 'hint', 'cue'].includes(k)), at).toEqual([]);
      });
    }
  });

  it('writes Japanese with full-width punctuation, no Latin letters, and a space only after ！ or ？', () => {
    const problems: string[] = [];
    for (const rp of rolePlays) {
      for (const [where, text] of textsOf(rp)) {
        const at = `${rp.id} ${where}`;
        for (const p of validateRuby(text)) problems.push(`${at}: ${p}`);
        const plain = rubyToPlain(text);
        if (/[A-Za-z0-9]/.test(plain)) problems.push(`${at}: Latin letters or digits in "${text}"`);
        if (/[!?,.;:()]/.test(plain)) problems.push(`${at}: half-width punctuation in "${text}"`);
        // Word spacing is a level-1 reading aid; otherwise a space only follows ！ or ？.
        if (rp.level > 1 && /(^|[^！？])[ 　]/.test(plain)) problems.push(`${at}: spaces in a level-${rp.level} script`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the couple's plain-register scenes casual and family terms right between them", () => {
    const problems: string[] = [];
    // Units 1–5 practise です/ます on purpose: their core conversations are polite even between partners.
    for (const rp of rolePlays.filter((r) => COUPLE.has(r.roles.a.nameJp) && COUPLE.has(r.roles.b.nameJp))) {
      rp.lines.forEach((l, i) => {
        const at = `${rp.id} lines[${i}]`;
        if (rp.register === 'plain' && /(です|ます|でした|ました|ません)[。！？…]*$/.test(rubyToKana(l.jp).replace(/\s/g, ''))) {
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

describe('voices (role a is read with the female voice, role b with the male voice)', () => {
  it('cast every role-play and task script so that each character speaks in their role\'s voice', () => {
    const problems = [
      ...rolePlays.flatMap((rp) => castProblems(rp.lines, rp.roles).map((p) => `${rp.id}: ${p}`)),
      ...units.flatMap((u) => castProblems(u.task.scripted).map((p) => `${u.task.id}: ${p}`)),
    ];
    expect(problems).toEqual([]);
    // The neighbour scene of unit 1 casts the newcomer as Ken (role b), Emma's husband.
    const rp = rolePlays.find((r) => r.id === 'rp-u01')!;
    expect(rp.roles.b.nameJp).toBe('ケン');
  });

  it('flag a woman in role b, a man in role a, and "my husband" or "my wife" in the wrong voice', () => {
    const roles = (a: string, b: string) => ({ a: { name: a, nameJp: '' }, b: { name: b, nameJp: '' } });
    expect(castProblems([], roles('Ms. Tanaka (neighbour)', 'Emma'))).toEqual([
      'role b "Emma" is a woman, but role b is read with the male voice',
    ]);
    expect(castProblems([], roles('Ken', 'Mr. Sato'))).toEqual(['role a "Ken" is a man, but role a is read with the female voice']);
    expect(castProblems([], { a: { name: 'Neighbour', nameJp: 'エマ' }, b: { name: 'Hikaru', nameJp: 'ひかる' } })).toEqual([]);
    expect(castProblems([], roles('Hikaru', 'Aoi'))).toEqual([]);

    const said = (role: 'a' | 'b', jp: string) => castProblems([{ role, jp }]);
    expect(said('b', 'ほんとうですか！ {夫|おっと}は{日本語|にほんご}の{学生|がくせい}です。')).toEqual([
      'lines[0] (role b, male voice) says {夫|おっと}, which only a woman says of their own spouse',
    ]);
    expect(said('a', '{妻|つま}のケイトもイギリス{人|じん}です。')).toHaveLength(1);
    expect(said('a', 'つまのケイトです。')).toHaveLength(1);
    expect(said('b', 'いいえ、{主人|しゅじん}のです。')).toHaveLength(1);
    // The right voice, someone else's husband, and words that only look alike.
    expect(said('a', '{夫|おっと}は{先生|せんせい}です。')).toEqual([]);
    expect(said('b', '{妻|つま}のです。')).toEqual([]);
    expect(said('b', 'ご{主人|しゅじん}はお{元気|げんき}ですか。')).toEqual([]);
    expect(said('b', '{大丈夫|だいじょうぶ}、{大丈夫|だいじょうぶ}。')).toEqual([]);
    expect(said('a', 'つまらないです。つまり、だめです。')).toEqual([]);
    expect(said('b', 'おっと！ すみません。')).toEqual([]);
  });

  it('fail the build on a role-play cast against its voices', () => {
    const rp = {
      id: 'rp-x', unit: 1, title: 't', titleJp: 't', setting: 's', level: 1, register: 'polite', targets: [],
      roles: { a: { name: 'Ms. Tanaka', nameJp: '{田中|たなか}' }, b: { name: 'Emma', nameJp: 'エマ' } },
      lines: [{ role: 'b', jp: '{夫|おっと}です。', en: 'My husband.', cue: 'c' }],
    };
    const ctx = { grammarOrder: new Map<string, number>(), coreIds: new Set<string>(), conversations: new Map<string, number>() };
    expect(buildRolePlays([rp], ctx).errors).toEqual([
      'rp-x: role b "Emma" is a woman, but role b is read with the male voice',
      'rp-x: lines[0] (role b, male voice) says {夫|おっと}, which only a woman says of their own spouse',
    ]);
  });
});

/** Readings a native speaker accepts that the dictionaries cannot derive, each checked by hand. */
const READING_ALLOW = new Set([
  '今日|きょう', '昨日|きのう', '明日|あした', '風邪|かぜ', '果物|くだもの', '大人|おとな',
  // お{母|かあ}さん, お{父|とう}さん: the jōyō special readings of 母さん and 父さん.
  '母|かあ', '父|とう',
  // お{腹|なか}: お腹 おなか.
  '腹|なか',
]);

/** Conjugated forms and phrases that are not dictionary headwords, checked by hand. */
const SURVIVAL_NOT_HEADWORD = new Set([
  'わかりません', 'わかりました', 'つかれた', 'あいしてる', 'がんばって', 'おねがいします',
  'よろしくおねがいします', 'もういちど', 'もういちどおねがいします', 'そうですか',
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
      for (const ch of [...w.written].filter(isKanji)) if (!(ch in kanji)) problems.push(`${w.id}: ${ch} is not a jōyō kanji`);
      if (!readsAs(w.written, w.kana)) problems.push(`${w.id}: "${w.written}" does not read as "${w.kana}"`);
    }
    expect(problems).toEqual([]);
  });

  it('uses jōyō kanji with readings JMdict or KANJIDIC support in every role-play', () => {
    const problems: string[] = [];
    for (const rp of rolePlays) {
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
