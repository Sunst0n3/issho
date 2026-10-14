// Small data set and module mocks for the study screen tests:
//   vi.mock('<path>/lib/data.ts', async () => (await import('<path>/test-utils.tsx')).dataMock);
//   vi.mock('<path>/writing/WritingPad.tsx', async () => (await import('<path>/test-utils.tsx')).writingPadMock);

import { forwardRef, useImperativeHandle } from 'react';
import { DEFAULT_SETTINGS, db } from '../../lib/db.ts';
import type {
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanjiEntry,
  RadicalEntry,
  SentenceEntry,
  Settings,
  SurvivalWord,
  WordEntry,
} from '../../lib/types.ts';
import type { WritingPadHandle, WritingPadProps } from '../../writing/WritingPad.tsx';

const kana = (char: string, romaji: string, order: number, script: KanaEntry['script'] = 'hiragana', kind: KanaEntry['kind'] = 'basic'): KanaEntry =>
  ({ char, script, romaji, group: romaji, kind, order });

export const KANA: KanaEntry[] = [
  kana('あ', 'a', 0), kana('い', 'i', 1), kana('う', 'u', 2), kana('え', 'e', 3), kana('お', 'o', 4),
  kana('か', 'ka', 5), kana('し', 'shi', 6), kana('み', 'mi', 7), kana('ず', 'zu', 8, 'hiragana', 'dakuten'),
  { ...kana('きゃ', 'kya', 9, 'hiragana', 'yoon') },
  kana('ア', 'a', 10, 'katakana'), kana('イ', 'i', 11, 'katakana'), kana('ウ', 'u', 12, 'katakana'), kana('エ', 'e', 13, 'katakana'),
];
KANA[6].altRomaji = ['si'];

const kanjiEntry = (char: string, meanings: string[], kun: string[], on: string[], components: string[] = []): KanjiEntry =>
  ({ char, meanings, kun, on, strokeCount: 4, components });

export const KANJI: Record<string, KanjiEntry> = {
  水: kanjiEntry('水', ['water'], ['みず'], ['スイ']),
  火: kanjiEntry('火', ['fire'], ['ひ'], ['カ']),
  木: kanjiEntry('木', ['tree', 'wood'], ['き'], ['モク', 'ボク']),
  金: kanjiEntry('金', ['gold', 'money'], ['かね'], ['キン']),
  日: kanjiEntry('日', ['day', 'sun'], ['ひ'], ['ニチ']),
  人: kanjiEntry('人', ['person'], ['ひと'], ['ジン']),
  曜: kanjiEntry('曜', ['weekday'], [], ['ヨウ']),
  池: kanjiEntry('池', ['pond'], ['いけ'], ['チ'], ['氵']),
};

export const RADICALS: RadicalEntry[] = [
  { char: '氵', name: 'water (side)', meaning: 'water', variantOf: '水' },
  { char: '亻', name: 'person (side)', meaning: 'person', variantOf: '人' },
  { char: '口', name: 'mouth', meaning: 'mouth' },
  { char: '扌', name: 'hand (side)', meaning: 'hand' },
  { char: '宀', name: 'roof', meaning: 'roof' },
];

const word = (id: string, written: string, kanaReading: string, meanings: string[], kanji: string[], freqRank = 10): WordEntry =>
  ({ id, written, kana: kanaReading, meanings, pos: ['n'], freqRank, kanji });

export const WORDS: WordEntry[] = [
  word('w-mizu', '水', 'みず', ['water'], ['水']),
  word('w-sui', '水曜日', 'すいようび', ['Wednesday'], ['水', '曜', '日']),
  word('w-hi', '火', 'ひ', ['fire'], ['火']),
  word('w-ki', '木', 'き', ['tree'], ['木']),
  word('w-kane', '金', 'かね', ['money'], ['金']),
  word('w-hito', '人', 'ひと', ['person'], ['人']),
  word('w-ike', '池', 'いけ', ['pond'], ['池']),
  word('w-terebi', 'テレビ', 'テレビ', ['television'], []),
];

export const CURRICULUM: Curriculum = {
  units: [
    { index: 0, type: 'kanji', char: '水', words: ['w-mizu'], phase: 2 },
    { index: 1, type: 'kanji', char: '火', words: ['w-hi'], phase: 2 },
    { index: 2, type: 'kanji', char: '木', words: ['w-ki'], phase: 2 },
    { index: 3, type: 'kanji', char: '金', words: ['w-kane'], phase: 2 },
    { index: 4, type: 'kanji', char: '人', words: ['w-hito'], phase: 2 },
    { index: 5, type: 'radical', char: '氵', words: [], phase: 2 },
    { index: 6, type: 'kanji', char: '池', words: ['w-ike'], phase: 2 },
  ],
  phaseEnds: { 2: 7, 3: 7, 4: 7 },
};

export const SURVIVAL: SurvivalWord[] = [
  { id: 'sw-ai', kana: 'あい', en: 'love' },
  { id: 'sw-ie', kana: 'いえ', en: 'house', note: 'A home or a building.' },
  { id: 'sw-ue', kana: 'うえ', en: 'above' },
  { id: 'sw-kao', kana: 'かお', en: 'face' },
  { id: 'sw-iie', kana: 'いいえ', en: 'no' },
];

export const GRAMMAR: GrammarPoint[] = [{
  id: 'wa-desu',
  order: 1,
  phase: 1,
  title: '〜は〜です — "X is Y"',
  pattern: '〜は〜です',
  explanation: 'X は Y です means "X is Y".',
  examples: [
    { jp: 'わたしはがくせいです。', en: 'I am a student.' },
    { jp: '{水|みず}です。', en: 'It is water.' },
  ],
  drills: [
    { prompt: 'わたし＿＿がくせいです。', options: ['を', 'は', 'か'], answer: 1, en: 'I am a student.' },
    { prompt: 'つまはせんせい＿＿。', options: ['は', 'を', 'です'], answer: 2, en: 'My wife is a teacher.' },
    { prompt: 'きょう＿＿げつようびです。', options: ['は', 'へ', 'を'], answer: 0, en: 'Today is Monday.' },
  ],
}];

export const SENTENCES: SentenceEntry[] = [
  { id: 's-mizu', jp: '{水|みず}をのむ。', en: 'I drink water.' },
  { id: 's-aoi', jp: 'あおい。', en: 'Blue.' },
  { id: 's-ie', jp: 'いえです。', en: 'It is a house.' },
  { id: 's-ue', jp: 'うえです。', en: 'It is above.' },
  { id: 's-kao', jp: 'かおです。', en: 'It is a face.' },
];

/** Simple straight strokes are enough: the real WritingPad is mocked. */
const lines = (n: number) => Array.from({ length: n }, (_, i) => `M${20 + i * 10} 20L${20 + i * 10} 90`);
export const STROKES: Record<string, string[]> = {
  あ: lines(3), い: lines(2), う: lines(2), し: lines(1), か: lines(3), ア: lines(2),
  水: lines(4), 火: lines(4), 木: lines(4), 金: lines(8), 人: lines(2), 池: lines(6), 氵: lines(3),
};

export const MNEMONICS: Record<string, string> = { 水: 'A stream splashing drops to both sides: water.' };

export const dataMock = {
  loadKana: async () => KANA,
  loadKanji: async () => KANJI,
  loadRadicals: async () => RADICALS,
  loadWords: async () => WORDS,
  loadWordIndex: async () => new Map(WORDS.map((w) => [w.id, w])),
  loadCurriculum: async () => CURRICULUM,
  loadStrokes: async () => STROKES,
  strokesFor: async (char: string) => STROKES[char],
  loadMnemonics: async () => MNEMONICS,
  loadSurvivalWords: async () => SURVIVAL,
  loadGrammar: async () => GRAMMAR,
  loadSentences: async () => SENTENCES,
  loadRolePlays: async () => [],
};

/**
 * Stand-in for the canvas: buttons finish the character cleanly, miss a
 * stroke, or (through the handle) give up.
 */
const MockWritingPad = forwardRef<WritingPadHandle, WritingPadProps>(function MockWritingPad(
  { strokes, mode, label, onStrokeResult, onComplete, disabled },
  ref,
) {
  const result = { mistakes: 0, hintsUsed: 0, strokeCount: strokes.length, gaveUp: false, failedStrokes: 0 };
  useImperativeHandle(ref, () => ({
    undo() {},
    clear() {},
    hint() {},
    giveUp() {
      onComplete?.({ ...result, gaveUp: true, failedStrokes: strokes.length });
    },
  }));
  return (
    <div role="img" aria-label={`Writing pad for ${label} (${mode})`} data-mode={mode}>
      <button type="button" disabled={disabled} onClick={() => onComplete?.(result)}>Finish writing</button>
      <button type="button" disabled={disabled}
        onClick={() => onStrokeResult?.(0, false, { ok: false, score: 0.2, reason: 'direction' })}>
        Miss a stroke
      </button>
    </div>
  );
});

export const writingPadMock = { WritingPad: MockWritingPad, AUTO_HINT_AFTER: 2 };

/** Empties every table and per-device storage, then stores settings for an onboarded learner. */
export async function resetStudyDb(settings: Partial<Settings> = {}): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  await db.settings.put({ ...DEFAULT_SETTINGS, onboarded: true, audio: false, ...settings, id: 'me' });
}
