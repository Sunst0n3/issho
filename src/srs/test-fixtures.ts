// Static data and helpers shared by the src/srs and src/lib tests.
// Tests mock the data loaders with:
//   vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../lib/db.ts';
import type { KanaExamplesFile, WordInfo } from '../lib/data.ts';
import type {
  AccentFile,
  AudioManifest,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanaScript,
  KanjiEntry,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  UnitSpec,
  WordEntry,
  WordRef,
} from '../lib/types.ts';

/** data.ts EMPTY_MANIFEST (data.ts itself is mocked by the tests, so it is not imported here). */
export const EMPTY_MANIFEST: AudioManifest = { version: 1, generatedAt: '', engine: '', credits: [], clips: {}, byRef: {}, byText: {} };

// ---------------------------------------------------------------------------
// The real kana table and rules (public/data/kana.json, content/kana-rules.json)
// ---------------------------------------------------------------------------

/** Tests run from the project root. */
const ROOT = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
}

/** Sprint day of a basic kana's row, for kana tables built before `sprintDay` existed. */
const ROW_DAY: Record<string, number> = { a: 1, ka: 1, sa: 2, ta: 2, na: 3, ha: 3, ma: 4, ya: 4, ra: 5, wa: 5, n: 5 };

function withSprintDays(kana: KanaEntry[]): KanaEntry[] {
  return kana.map((k) => {
    if (k.kind !== 'basic' || k.sprintDay !== undefined) return k;
    return { ...k, sprintDay: ROW_DAY[k.group] + (k.script === 'katakana' ? 7 : 0) };
  });
}

function withScripts(rules: KanaRule[]): KanaRule[] {
  return rules.map((r) => ({ ...r, script: r.script ?? ((r.id.startsWith('hira') ? 'hiragana' : 'katakana') as KanaScript) }));
}

/** All 208 kana, with the 92 basic ones carrying their sprint day. */
export const REAL_KANA: KanaEntry[] = withSprintDays(readJson<KanaEntry[]>('public/data/kana.json'));
/** The four kana-rule lessons. */
export const REAL_RULES: KanaRule[] = withScripts(readJson<KanaRule[]>('content/kana-rules.json'));
export const KANA = REAL_KANA;
export const RULES = REAL_RULES;
export const BASIC_HIRAGANA = REAL_KANA.filter((k) => k.kind === 'basic' && k.script === 'hiragana').map((k) => k.char);
export const BASIC_KATAKANA = REAL_KANA.filter((k) => k.kind === 'basic' && k.script === 'katakana').map((k) => k.char);

// ---------------------------------------------------------------------------
// A small course: kanji with anchors and staged words, core words, grammar
// ---------------------------------------------------------------------------

function word(id: string, written: string, kana: string, en: string, kanji: string[], extra: Partial<WordEntry> = {}): WordEntry {
  return { id, written, kana, meanings: [en], pos: ['n'], freqRank: 10, kanji, ...extra };
}

export const WORDS: WordEntry[] = [
  word('1001', '日', 'ひ', 'day; sun', ['日']),
  word('1002', '日本', 'にほん', 'Japan', ['日', '本'], { use: true }),
  word('1003', '元日', 'がんじつ', "New Year's Day", ['元', '日']),
  word('1004', '未来', 'みらい', 'future', ['未', '来']),
  word('1005', '週末', 'しゅうまつ', 'weekend', ['週', '末']),
  word('1006', '本', 'ほん', 'book', ['本']),
  word('1007', '人', 'ひと', 'person', ['人'], { use: true }),
  word('1008', '本日', 'ほんじつ', 'today (formal)', ['本', '日']),
  word('2001', '一つ', 'ひとつ', 'one (thing)', ['一']),
  word('2002', '一人', 'ひとり', 'one person', ['一', '人']),
  word('2003', '二つ', 'ふたつ', 'two (things)', ['二']),
  word('2004', '三つ', 'みっつ', 'three (things)', ['三']),
  word('2005', '四つ', 'よっつ', 'four (things)', ['四']),
  word('2006', '五つ', 'いつつ', 'five (things)', ['五']),
  word('2007', '気', 'き', 'spirit', ['気']),
];

const unit = (index: number, char: string, anchor: WordRef | null, staged: WordRef[] = []) => ({
  index,
  char,
  anchor,
  staged,
  inferable: false,
  chapter: Math.floor(index / 15) + 1,
});

export const CURRICULUM: Curriculum = {
  version: 2,
  units: [
    unit(0, '一', 'word:2001', ['word:2002']),
    unit(1, '二', 'word:2003'),
    unit(2, '三', 'word:2004'),
    unit(3, '四', 'word:2005'),
    unit(4, '五', 'word:2006'),
    unit(5, '日', 'word:1001', ['word:1002', 'word:1008']),
    unit(6, '元', 'core:cw-0040', ['word:1003']),
    unit(7, '気', 'core:cw-0041'),
    unit(8, '未', 'word:1004'),
    unit(9, '末', 'word:1005'),
    unit(10, '本', 'word:1006'),
    unit(11, '乙', null),
    unit(12, '人', 'word:1007'),
  ],
  confusables: [
    { id: 'm-numbers', chars: ['一', '二', '三', '四', '五'], kind: 'meaning' },
    { id: 'v-未末', chars: ['未', '末'], kind: 'visual' },
  ],
};

function core(order: number, kana: string, en: string, extra: Partial<CoreWord> = {}): CoreWord {
  return {
    id: `cw-${String(order).padStart(4, '0')}`,
    order,
    kana,
    en,
    pos: 'expression',
    register: 'both',
    topic: 'test',
    use: true,
    kanji: [],
    unit: order <= 20 ? 1 : 2,
    ...extra,
  };
}

const KANA_WORDS = [
  'ありがとう', 'すみません', 'はい', 'いいえ', 'おはよう', 'こんにちは', 'こんばんは', 'さようなら', 'おやすみ', 'ごめんなさい',
  'いただきます', 'ごちそうさま', 'ただいま', 'おかえり', 'どうぞ', 'どうも', 'ちょっと', 'もう', 'まだ', 'すごい',
  'いい', 'だめ', 'あれ', 'これ', 'それ', 'どれ', 'ここ', 'そこ', 'あそこ', 'どこ',
  'いま', 'あさ', 'ひる', 'よる', 'あした', 'きのう', 'きょう', 'まいにち', 'いつ',
];

export const CORE: CoreWord[] = [
  ...KANA_WORDS.map((kana, i) => core(i + 1, kana, `word ${i + 1}`, { use: i % 5 !== 4 })),
  core(40, 'げんき', 'well; healthy', { written: '元気', kanji: ['元', '気'] }),
  core(41, 'き', 'spirit; mood', { written: '気', kanji: ['気'], use: false }),
  core(42, 'ほんとう', 'really', { written: '本当', kanji: ['本', '当'] }),
  core(43, 'コーヒー', 'coffee', { pos: 'noun' }),
  core(44, 'ひと', 'person', { written: '人', kanji: ['人'], pos: 'noun' }),
  core(45, 'ジュース', 'juice', { pos: 'noun', use: false }),
];

function grammar(order: number, id: string, extra: Partial<GrammarPoint> = {}): GrammarPoint {
  return {
    id,
    order,
    level: 'N5',
    title: id,
    pattern: `〜${id}`,
    register: 'polite',
    prerequisites: [],
    contrastWith: [],
    explanation: '',
    examples: Array.from({ length: 8 }, (_, i) => ({ jp: `れい${i}です。`, en: `Example ${i}` })),
    buildItems: [{ en: 'I am a company employee.', jp: '{私|わたし}は{会社員|かいしゃいん}です。', tiles: ['私は', '会社員', 'です'], alternatives: [], answers: ['わたしはかいしゃいんです', 'わたしわかいしゃいんです'] }],
    drills: [],
    unit: order <= 4 ? 1 : order <= 8 ? 2 : 3,
    ...extra,
  };
}

export const GRAMMAR: GrammarPoint[] = [
  grammar(1, 'wa-desu', { contrastWith: ['mo-also', 'ga-subject'] }),
  grammar(2, 'ka-question', { prerequisites: ['wa-desu'] }),
  grammar(3, 'no-possession', { prerequisites: ['wa-desu'] }),
  grammar(4, 'mo-also', { prerequisites: ['wa-desu'], contrastWith: ['wa-desu'] }),
  grammar(5, 'ga-subject', { prerequisites: ['wa-desu'] }),
  grammar(6, 'numbers-prices', { prerequisites: ['ka-question'] }),
  grammar(7, 'counting-tsu', { prerequisites: ['numbers-prices'] }),
  grammar(8, 'time-telling', { prerequisites: ['numbers-prices'] }),
  grammar(9, 'counters-people', { prerequisites: ['counting-tsu'] }),
  grammar(10, 'counters-objects', { prerequisites: ['counting-tsu'] }),
  grammar(11, 'passive', { prerequisites: ['ga-subject'], recognitionOnly: true, buildItems: [] }),
  grammar(12, 'te-form', { prerequisites: ['ga-subject'] }),
];

export const KANJI: Record<string, KanjiEntry> = Object.fromEntries(
  CURRICULUM.units.map((u) => [
    u.char,
    { char: u.char, meanings: [`kanji ${u.char}`], on: [], kun: ['き'], strokeCount: 4, components: [], parts: [], rank: u.index + 1 },
  ]),
);

export const SENTENCES: SentenceEntry[] = [];
export const STORIES: StoryEntry[] = [];

/** Mutable copies the mocked loaders read; reset with resetFixtures(). */
export const fixtures = {
  kana: KANA,
  rules: RULES,
  curriculum: CURRICULUM,
  core: CORE,
  grammar: GRAMMAR,
  words: WORDS,
  kanji: KANJI,
  sentences: SENTENCES,
  stories: STORIES,
  rolePlays: [] as RolePlay[],
  units: [] as UnitSpec[],
  accent: {} as AccentFile,
  manifest: EMPTY_MANIFEST as AudioManifest,
  kanaExamples: {} as KanaExamplesFile,
};

export function resetFixtures(): void {
  fixtures.kana = KANA;
  fixtures.rules = RULES;
  fixtures.curriculum = CURRICULUM;
  fixtures.core = CORE;
  fixtures.grammar = GRAMMAR;
  fixtures.words = WORDS;
  fixtures.kanji = KANJI;
  fixtures.sentences = SENTENCES;
  fixtures.stories = STORIES;
  fixtures.rolePlays = [];
  fixtures.units = [];
  fixtures.accent = {};
  fixtures.manifest = EMPTY_MANIFEST;
  fixtures.kanaExamples = {};
}

/** data.ts loadWordInfo over the fixtures. */
export function wordInfoOf(ref: string): WordInfo | undefined {
  if (ref.startsWith('core:')) {
    const c = fixtures.core.find((w) => `core:${w.id}` === ref);
    if (!c) return undefined;
    return {
      ref: `core:${c.id}`, written: c.written ?? c.kana, kana: c.kana, en: c.en, kanji: c.kanji, use: c.use,
      readings: [c.kana, ...(c.altKana ?? [])], register: c.register, note: c.note, core: c,
    };
  }
  const w = fixtures.words.find((e) => `word:${e.id}` === ref);
  if (!w) return undefined;
  return {
    ref: `word:${w.id}`, written: w.written, kana: w.kana, en: w.meanings.join('; '), kanji: w.kanji,
    use: w.use ?? false, readings: [w.kana, ...(w.altKana ?? [])], entry: w,
  };
}

export const dataMock = {
  EMPTY_MANIFEST,
  loadKana: async () => fixtures.kana,
  loadKanaRules: async () => fixtures.rules,
  loadCurriculum: async () => fixtures.curriculum,
  loadCoreWords: async () => fixtures.core,
  loadCoreIndex: async () => new Map(fixtures.core.map((w) => [w.id, w])),
  loadGrammar: async () => fixtures.grammar,
  loadGrammarIndex: async () => new Map(fixtures.grammar.map((g) => [g.id, g])),
  loadWords: async () => fixtures.words,
  loadWordIndex: async () => new Map(fixtures.words.map((w) => [w.id, w])),
  loadWordInfo: async () => wordInfoOf,
  loadKanji: async () => fixtures.kanji,
  loadSentences: async () => fixtures.sentences,
  loadStories: async () => fixtures.stories,
  loadRolePlays: async () => fixtures.rolePlays,
  loadUnits: async () => fixtures.units,
  loadAccent: async () => fixtures.accent,
  loadAudioManifest: async () => fixtures.manifest,
  loadKanaExamples: async () => fixtures.kanaExamples,
  loadMnemonics: async () => ({}),
  loadRadicals: async () => [],
  loadStrokes: async () => ({}),
  strokesFor: async () => undefined,
  audioUrl: (file: string) => `/audio/${file}`,
  clearDataCache: () => {},
};

// ---------------------------------------------------------------------------
// Database and time helpers
// ---------------------------------------------------------------------------

/** Empties every table (modules share the singleton db) and per-device storage. */
export async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
  try {
    localStorage.clear();
  } catch {
    // No storage in this environment.
  }
  resetFixtures();
}

/** A local date-time; day keys roll over at 4 a.m. local time. */
export function at(y: number, month: number, d: number, h = 12, min = 0): Date {
  return new Date(y, month - 1, d, h, min);
}

/** Runs `fn` in another local time zone (Node picks up a changed TZ at once). */
export async function inTimeZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}
