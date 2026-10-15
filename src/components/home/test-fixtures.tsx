// Small static data set for the home screen tests. Tests mock the loaders with:
//   vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

import { configure, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createEmptyCard, State } from 'ts-fsrs';
// Type-only: the data module itself is what the tests mock with dataMock.
import type { WordInfo } from '../../lib/data.ts';
import { db } from '../../lib/db.ts';
import type {
  AccentFile,
  AudioManifest,
  CardRecord,
  CardType,
  CoreWord,
  Curriculum,
  CurriculumUnit,
  GrammarPoint,
  ItemKind,
  KanaEntry,
  KanjiEntry,
  RadicalEntry,
  StoryEntry,
  UnitSpec,
  WordEntry,
  WordRef,
} from '../../lib/types.ts';

// Screens load data and several modules on their first render; with the whole suite running in
// parallel that can take longer than the default second.
configure({ asyncUtilTimeout: 4000 });

export const KANA: KanaEntry[] = [
  ...[...'あいうえお'].map((char, i): KanaEntry => ({ char, script: 'hiragana', romaji: 'aiueo'[i], group: 'a', kind: 'basic', order: i, sprintDay: 1 })),
  ...[...'アイウエオ'].map((char, i): KanaEntry => ({ char, script: 'katakana', romaji: 'aiueo'[i], group: 'a', kind: 'basic', order: 5 + i, sprintDay: 8 })),
  { char: 'きゃ', script: 'hiragana', romaji: 'kya', group: 'kya', kind: 'yoon', order: 10 },
];

const unit = (index: number, char: string, anchor: WordRef | null = null, staged: WordRef[] = []): CurriculumUnit =>
  ({ index, char, anchor, staged, inferable: false, chapter: Math.floor(index / 15) + 1 });

export const CURRICULUM: Curriculum = {
  version: 2,
  units: [
    unit(0, '日', 'word:w-hi', ['word:w-nichi']),
    unit(1, '一', 'word:w-ichi'),
    unit(2, '水', 'core:cw-0005', ['word:w-suiyou']),
    unit(3, '火', null),
    unit(4, '木', 'word:w-ki'),
    unit(5, '休', 'word:w-yasumi'),
    unit(6, '金'),
    unit(7, '土'),
    unit(15, '山'),
  ],
  confusables: [],
};

const kanji = (char: string, meaning: string, kun: string[] = [], on: string[] = [], components: string[] = [], parts: string[] = [], rank?: number): KanjiEntry =>
  ({ char, meanings: [meaning], kun, on, strokeCount: 4, components, parts, rank, jlptOld: 4 });

export const KANJI: Record<string, KanjiEntry> = Object.fromEntries([
  kanji('日', 'day', ['ひ'], ['ニチ'], [], [], 1),
  kanji('一', 'one', ['ひと.つ'], ['イチ'], [], [], 2),
  kanji('水', 'water', ['みず'], ['スイ'], [], [], 3),
  kanji('火', 'fire', ['ひ'], ['カ'], [], [], 4),
  kanji('木', 'tree', ['き'], ['モク'], [], [], 5),
  kanji('休', 'rest', ['やす.む'], ['キュウ'], ['木'], ['亻'], 6),
  kanji('金', 'gold', ['かね'], ['キン'], [], [], 7),
  kanji('土', 'soil', ['つち'], ['ド'], [], [], 8),
  kanji('山', 'mountain', ['やま'], ['サン'], [], [], 16),
].map((k) => [k.char, k]));

export const RADICALS: RadicalEntry[] = [
  { char: '亻', name: 'person (side)', meaning: 'person', variantOf: '人' },
  { char: '氵', name: 'water (side)', meaning: 'water', variantOf: '水' },
];

export const WORDS: WordEntry[] = [
  { id: 'w-hi', written: '日', kana: 'ひ', meanings: ['day', 'sun'], pos: ['n'], freqRank: 3, kanji: ['日'] },
  { id: 'w-nichi', written: '日曜日', kana: 'にちようび', meanings: ['Sunday'], pos: ['n'], freqRank: 1, kanji: ['日', '曜'] },
  { id: 'w-honjitsu', written: '本日', kana: 'ほんじつ', meanings: ['today'], pos: ['n'], freqRank: 20, kanji: ['本', '日'] },
  { id: 'w-mainichi', written: '毎日', kana: 'まいにち', meanings: ['every day'], pos: ['n'], freqRank: 2, kanji: ['毎', '日'] },
  { id: 'w-ichi', written: '一', kana: 'いち', meanings: ['one'], pos: ['num'], freqRank: 1, kanji: ['一'] },
  { id: 'w-mizu', written: '水', kana: 'みず', meanings: ['water'], pos: ['n'], freqRank: 1, kanji: ['水'], core: 'cw-0005' },
  { id: 'w-suiyou', written: '水曜日', kana: 'すいようび', meanings: ['Wednesday'], pos: ['n'], freqRank: 2, kanji: ['水', '曜', '日'] },
  { id: 'w-ki', written: '木', kana: 'き', meanings: ['tree'], pos: ['n'], freqRank: 1, kanji: ['木'] },
  { id: 'w-yasumi', written: '休み', kana: 'やすみ', meanings: ['rest', 'holiday'], pos: ['n'], freqRank: 1, kanji: ['休'] },
];

const core = (order: number, kana: string, en: string, written?: string, unitId = 1): CoreWord => ({
  id: `cw-${String(order).padStart(4, '0')}`, order, kana, written, en, pos: 'noun', register: 'both', topic: 'basics',
  use: true, kanji: written ? [...written].filter((c) => /[一-鿿]/.test(c)) : [], unit: unitId,
});

export const CORE: CoreWord[] = [
  core(1, 'ありがとう', 'thank you'),
  core(2, 'もう', 'already'),
  core(3, 'まだ', 'not yet'),
  core(4, 'コーヒー', 'coffee'),
  core(5, 'みず', 'water', '水'),
];

const grammarPoint = (id: string, order: number, title: string, pattern: string, unitId: number): GrammarPoint => ({
  id, order, level: 'N5', title, pattern, register: 'polite', prerequisites: [], contrastWith: [], explanation: '',
  examples: [], buildItems: [], drills: [], unit: unitId,
});

export const GRAMMAR: GrammarPoint[] = [
  grammarPoint('wa-desu', 1, 'X is Y', 'XはYです', 1),
  grammarPoint('ka-question', 2, 'Questions with か', '〜か', 1),
  grammarPoint('tai', 3, 'Want to', '〜たい', 2),
];

const canDo = (id: string, text: string, kind: 'read' | 'speak', ready = true) => ({
  id, text, ready,
  check: { kind, instructions: '', material: '', questions: [] },
});

export const UNITS: UnitSpec[] = [
  {
    id: 1, title: 'Hello, us', titleJp: '{私|わたし}たち', level: 'A1', topic: 'greetings',
    grammar: ['wa-desu', 'ka-question'], coreWordCeiling: 40,
    canDos: [
      canDo('u01-cd1', 'Greet each other at any time of day', 'speak'),
      canDo('u01-cd2', 'Read a name card', 'read'),
      canDo('u01-cd3', 'Introduce your partner', 'speak', false),
    ],
    conversation: 'rp-u01',
    task: { id: 'u01-task', canDo: 'u01-cd1', goal: '', outcomeQuestion: '', roles: { a: '', b: '' }, infoA: '', infoB: '', targets: [], register: 'polite', twist: '', scripted: [], ready: false },
    capstone: { title: '', brief: '', minLinesEach: 4, structures: [] },
  },
];

const story = (id: string, level: StoryEntry['level'], title: string, titleJp: string, refs: WordRef[]): StoryEntry => ({
  id, level, unit: 1, title, titleJp, topic: 'daily', grammar: [], chars: 240, refs,
  gist: { q: '', options: [], answer: 0 },
  sentences: [{ jp: titleJp, en: title, phrases: [titleJp], tokens: refs.map((ref) => ({ s: ref, ref, k: 'c' as const })) }],
});

export const STORIES: StoryEntry[] = [
  story('st-start-01', 'start', 'Morning coffee', 'あさのコーヒー', ['core:cw-0004']),
  story('st-l0-02', 'L0', 'Rain', '{雨|あめ}', ['core:cw-0004', 'core:cw-0002']),
  story('st-l1-03', 'L1', 'The station', '{駅|えき}', ['word:w-nichi']),
];

export const ACCENT: AccentFile = {
  'core:cw-0005': { moras: ['ミ', 'ズ'], drop: 0, type: 'heiban', withGa: true },
  'word:w-hi': { moras: ['ヒ'], drop: 1, type: 'atamadaka', withGa: true },
};

const EMPTY_MANIFEST: AudioManifest = { version: 1, generatedAt: '', engine: '', credits: [], clips: {}, byRef: {}, byText: {} };

export const MANIFEST: AudioManifest = { ...EMPTY_MANIFEST, credits: ['VOICEVOX:No.7', 'VOICEVOX:青山龍星'] };

function wordInfoOf(ref: string): WordInfo | undefined {
  if (ref.startsWith('core:')) {
    const c = CORE.find((w) => `core:${w.id}` === ref);
    return c && {
      ref: `core:${c.id}`, written: c.written ?? c.kana, kana: c.kana, en: c.en, kanji: c.kanji, use: c.use,
      readings: [c.kana], register: c.register, core: c,
    };
  }
  const w = WORDS.find((e) => `word:${e.id}` === ref);
  return w && {
    ref: `word:${w.id}`, written: w.written, kana: w.kana, en: w.meanings.join('; '), kanji: w.kanji, use: false,
    readings: [w.kana], entry: w,
  };
}

export const dataMock = {
  EMPTY_MANIFEST,
  loadKana: async () => KANA,
  loadKanji: async () => KANJI,
  loadRadicals: async () => RADICALS,
  loadWords: async () => WORDS,
  loadCurriculum: async () => CURRICULUM,
  loadStrokes: async () => ({}),
  loadAccent: async () => ACCENT,
  loadCoreWords: async () => CORE,
  loadKanaRules: async () => [],
  loadKanaExamples: async () => ({}),
  loadMnemonics: async () => ({ 水: { meaning: 'Three drops running beside a stream.', sound: 'Mizu: me, zoo, splash.' } }),
  loadGrammar: async () => GRAMMAR,
  loadSentences: async () => [],
  loadStories: async () => STORIES,
  loadRolePlays: async () => [],
  loadUnits: async () => UNITS,
  loadAudioManifest: async () => MANIFEST,
  audioUrl: (file: string) => `/audio/${file}`,
  loadWordIndex: async () => new Map(WORDS.map((w) => [w.id, w])),
  loadCoreIndex: async () => new Map(CORE.map((w) => [w.id, w])),
  loadGrammarIndex: async () => new Map(GRAMMAR.map((g) => [g.id, g])),
  loadWordInfo: async () => wordInfoOf,
  strokesFor: async () => undefined,
  clearDataCache: () => {},
};

export async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}

/** A card record for tests, in Review unless told otherwise. */
export function cardOf(item: string, kind: ItemKind, type: CardType, patch: Partial<CardRecord> = {}): CardRecord {
  const now = new Date();
  return {
    ...createEmptyCard(now),
    id: `${item}|${type}`,
    itemId: item,
    kind,
    type,
    state: State.Review,
    reps: 3,
    stability: 10,
    due: new Date(now.getTime() + 5 * 86_400_000),
    ...patch,
  };
}

/** Introduces a kanji with a Review-state write card. */
export async function addLearned(char: string, card: Partial<CardRecord> = {}, item: { pinned?: boolean; introducedAt?: Date } = {}): Promise<void> {
  const id = `kanji:${char}`;
  await db.items.add({ id, kind: 'kanji', key: char, introducedAt: item.introducedAt ?? new Date(), pinned: item.pinned });
  await db.cards.add(cardOf(id, 'kanji', 'write', card));
}

/** Renders `element` at `path` with stand-ins for the routes the screens link or redirect to. */
export function renderAt(path: string, routePath: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path={routePath} element={element} />
        {routePath !== '/' && <Route path="/" element={<p>Home screen</p>} />}
        {routePath !== '/welcome' && <Route path="/welcome" element={<p>Welcome screen</p>} />}
        <Route path="*" element={<p>Other screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
