// Small static data set and helpers shared by the src/srs tests.
// Tests mock the data loaders with:
//   vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

import { db } from '../lib/db.ts';
import type {
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaKind,
  KanaScript,
  SentenceEntry,
  SurvivalWord,
} from '../lib/types.ts';

function kanaRows(script: KanaScript, start: number, rows: [KanaKind, string, string[], string][]): KanaEntry[] {
  const out: KanaEntry[] = [];
  for (const [kind, group, romaji, chars] of rows) {
    [...chars.matchAll(/.[ゃゅょャュョ]?/gu)].forEach(([char], i) => {
      out.push({ char, script, romaji: romaji[i], group, kind, order: start + out.length });
    });
  }
  return out;
}

const HIRAGANA = kanaRows('hiragana', 0, [
  ['basic', 'a', ['a', 'i', 'u', 'e', 'o'], 'あいうえお'],
  ['basic', 'ka', ['ka', 'ki', 'ku', 'ke', 'ko'], 'かきくけこ'],
  ['basic', 'n', ['n'], 'ん'],
  ['dakuten', 'ga', ['ga', 'go'], 'がご'],
  ['yoon', 'kya', ['kya'], 'きゃ'],
]);

const KATAKANA = kanaRows('katakana', HIRAGANA.length, [
  ['basic', 'a', ['a', 'i', 'u', 'e', 'o'], 'アイウエオ'],
  ['basic', 'ka', ['ka', 'ki', 'ku', 'ke', 'ko'], 'カキクケコ'],
  ['basic', 'n', ['n'], 'ン'],
  ['dakuten', 'ga', ['ga'], 'ガ'],
  ['yoon', 'kya', ['kya'], 'キャ'],
]);

export const KANA: KanaEntry[] = [...HIRAGANA, ...KATAKANA];
export const BASIC_HIRAGANA = HIRAGANA.filter((k) => k.kind === 'basic').map((k) => k.char);

export const SURVIVAL: SurvivalWord[] = [
  { id: 'sw-ai', kana: 'あい', en: 'love' },
  { id: 'sw-iie', kana: 'いいえ', en: 'no' },
  { id: 'sw-gogo', kana: 'ごご', en: 'afternoon' },
  { id: 'sw-kyaku', kana: 'きゃく', en: 'guest' },
  { id: 'sw-kao', kana: 'かお', en: 'face' },
  { id: 'sw-kokoa', kana: 'ココア', en: 'cocoa' },
];

function grammarPoint(
  id: string,
  order: number,
  phase: GrammarPoint['phase'],
  text: Pick<GrammarPoint, 'pattern' | 'examples' | 'drills'>,
): GrammarPoint {
  return { id, order, phase, title: id, explanation: '', ...text };
}

const drill = (prompt: string, options: string[]) => ({ prompt, options, answer: 0, en: '' });

/** The kana g-wa needs: か (pattern), あ い こ (example furigana; っ is skipped), こ (drill), え お (options). */
export const G_WA_KANA = ['か', 'あ', 'い', 'こ', 'え', 'お'];

export const GRAMMAR: GrammarPoint[] = [
  // Needs が; きゃ く (a yōon counts as one); き う (きょ isn't in this course,
  // so ょ is skipped); ご (ー is skipped); い う.
  grammarPoint('g-ka', 2, 1, {
    pattern: '〜が',
    examples: [
      { jp: 'きゃく', en: 'guest' },
      { jp: 'きょう', en: 'today' },
    ],
    drills: [drill('ごー＿＿', ['い', 'う'])],
  }),
  grammarPoint('g-wa', 1, 1, {
    pattern: '〜か',
    examples: [{ jp: '{赤|あか}いっこ', en: 'one red one' }],
    drills: [drill('こ＿＿', ['え', 'お'])],
  }),
  // Needs コ ア; カ; イ ウ.
  grammarPoint('g-te', 3, 2, {
    pattern: '〜て',
    examples: [{ jp: 'ココア', en: 'cocoa' }],
    drills: [drill('カ＿＿', ['イ', 'ウ'])],
  }),
];

export const CURRICULUM: Curriculum = {
  units: [
    { index: 0, type: 'radical', char: '亻', words: [], phase: 2 },
    { index: 1, type: 'kanji', char: '一', words: ['1001'], phase: 2 },
    { index: 2, type: 'kanji', char: '人', words: ['1002', '1003'], phase: 2 },
    { index: 3, type: 'kanji', char: '大', words: ['1004'], phase: 3 },
    { index: 4, type: 'kanji', char: '水', words: [], phase: 4 },
  ],
  phaseEnds: { '2': 3, '3': 4, '4': 5 },
};

export const SENTENCES: SentenceEntry[] = [
  { id: 's-kana', jp: 'あおい。', en: 'Blue.' },
  { id: 's-ichi', jp: '{一|いち}', en: 'One.' },
  { id: 's-hito', jp: '{一|ひと}り{人|ひと}', en: 'One person.' },
  { id: 's-big', jp: '{大|おお}きい{水|みず}', en: 'Big water.' },
];

/** Mutable copies the mocked loaders read; reset with resetFixtures(). */
export const fixtures = {
  kana: KANA,
  curriculum: CURRICULUM,
  survival: SURVIVAL,
  grammar: GRAMMAR,
  sentences: SENTENCES,
};

export function resetFixtures(): void {
  fixtures.kana = KANA;
  fixtures.curriculum = CURRICULUM;
  fixtures.survival = SURVIVAL;
  fixtures.grammar = GRAMMAR;
  fixtures.sentences = SENTENCES;
}

export const dataMock = {
  loadKana: async () => fixtures.kana,
  loadCurriculum: async () => fixtures.curriculum,
  loadSurvivalWords: async () => fixtures.survival,
  loadGrammar: async () => fixtures.grammar,
  loadSentences: async () => fixtures.sentences,
};

/** A working in-memory Web Storage. */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

// Node 25 ships its own global localStorage, a non-functional stub unless
// --localstorage-file is set, and it shadows jsdom's. Swap in a real one.
function ensureLocalStorage(): void {
  if (typeof globalThis.localStorage?.clear !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
  }
}

/** Empties every table (modules share the singleton db) and per-device storage. */
export async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
  ensureLocalStorage();
  localStorage.clear();
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
