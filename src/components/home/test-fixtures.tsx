// Small static data set for the home screen tests. Tests mock the loaders with:
//   vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { State } from 'ts-fsrs';
import { db } from '../../lib/db.ts';
import type {
  CardRecord,
  Curriculum,
  CurriculumUnit,
  KanaEntry,
  KanjiEntry,
  RadicalEntry,
  WordEntry,
} from '../../lib/types.ts';
import { newCardRecord } from '../../srs/scheduler.ts';

export const KANA: KanaEntry[] = [
  ...[...'あいうえお'].map((char, i): KanaEntry => ({ char, script: 'hiragana', romaji: 'aiueo'[i], group: 'a', kind: 'basic', order: i })),
  ...[...'アイウエオ'].map((char, i): KanaEntry => ({ char, script: 'katakana', romaji: 'aiueo'[i], group: 'a', kind: 'basic', order: 5 + i })),
];

const unit = (index: number, type: CurriculumUnit['type'], char: string, phase: number, words: string[] = []): CurriculumUnit =>
  ({ index, type, char, phase, words });

export const CURRICULUM: Curriculum = {
  units: [
    unit(0, 'kanji', '日', 2, ['w-nichi']),
    unit(1, 'kanji', '一', 2),
    unit(2, 'radical', '氵', 2),
    unit(3, 'kanji', '水', 2, ['w-mizu']),
    unit(4, 'kanji', '火', 2),
    unit(5, 'kanji', '木', 2),
    unit(6, 'kanji', '金', 3),
    unit(7, 'kanji', '土', 3),
    unit(8, 'kanji', '山', 4),
  ],
  phaseEnds: { 2: 6, 3: 8, 4: 9 },
};

const kanji = (char: string, meaning: string, kun: string[] = [], on: string[] = [], components: string[] = []): KanjiEntry =>
  ({ char, meanings: [meaning], kun, on, strokeCount: 4, components });

export const KANJI: Record<string, KanjiEntry> = Object.fromEntries([
  kanji('日', 'day', ['ひ'], ['ニチ']),
  kanji('一', 'one', ['ひと.つ'], ['イチ']),
  kanji('水', 'water', ['みず'], ['スイ']),
  kanji('火', 'fire', ['ひ'], ['カ']),
  kanji('木', 'tree', ['き'], ['モク']),
  kanji('金', 'gold', ['かね'], ['キン']),
  kanji('土', 'soil', ['つち'], ['ド']),
  kanji('山', 'mountain', ['やま'], ['サン']),
].map((k) => [k.char, k]));

export const RADICALS: RadicalEntry[] = [{ char: '氵', name: 'water (side)', meaning: 'water', variantOf: '水' }];

export const WORDS: WordEntry[] = [
  { id: 'w-nichi', written: '日曜日', kana: 'にちようび', meanings: ['Sunday'], pos: ['n'], freqRank: 1, kanji: ['日', '曜'] },
  { id: 'w-mizu', written: '水', kana: 'みず', meanings: ['water'], pos: ['n'], freqRank: 1, kanji: ['水'] },
];

export const dataMock = {
  loadKana: async () => KANA,
  loadKanji: async () => KANJI,
  loadRadicals: async () => RADICALS,
  loadWords: async () => WORDS,
  loadCurriculum: async () => CURRICULUM,
  loadStrokes: async () => ({}),
  loadMnemonics: async () => ({ 水: 'Three drops running beside a stream.' }),
  loadSurvivalWords: async () => [],
  loadGrammar: async () => [],
  loadSentences: async () => [],
  loadRolePlays: async () => [],
  loadWordIndex: async () => new Map(WORDS.map((w) => [w.id, w])),
  strokesFor: async () => undefined,
};

export async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}

/** Introduces a kanji or radical with Review-state cards, optionally struggling. */
export async function addLearned(kind: 'kanji' | 'radical', char: string, card: Partial<CardRecord> = {}): Promise<void> {
  const id = `${kind}:${char}`;
  const now = new Date();
  await db.items.add({ id, kind, key: char, introducedAt: now });
  await db.cards.add({
    ...newCardRecord(id, kind, 'meaning', now),
    state: State.Review,
    reps: 3,
    stability: 10,
    due: new Date(now.getTime() + 5 * 86_400_000),
    ...card,
  });
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
