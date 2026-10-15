// Small v2 data set and module mocks for the study screen tests:
//   vi.mock('<path>/lib/data.ts', async () => (await import('<path>/test-utils.tsx')).dataMock);
//   vi.mock('<path>/writing/WritingPad.tsx', async () => (await import('<path>/test-utils.tsx')).writingPadMock);
//   vi.mock('<path>/speech/audio.ts', async () => (await import('<path>/test-utils.tsx')).audioMock);

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { vi } from 'vitest';
import { DEFAULT_SETTINGS, db } from '../../lib/db.ts';
import type { KanaExample, WordInfo } from '../../lib/data.ts';
import type {
  AccentFile,
  AudioManifest,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  MnemonicsFile,
  PreToken,
  RadicalEntry,
  SentenceEntry,
  Settings,
  StoryEntry,
  UnitSpec,
  WordEntry,
} from '../../lib/types.ts';
import type { PlayResult } from '../../speech/audio.ts';
import type { UnorderedMatch } from '../../writing/matcher.ts';
import type { WritingPadHandle, WritingPadProps } from '../../writing/WritingPad.tsx';

const kana = (char: string, romaji: string, order: number, group: string, sprintDay?: number,
  script: KanaEntry['script'] = 'hiragana', kind: KanaEntry['kind'] = 'basic'): KanaEntry =>
  ({ char, script, romaji, group, kind, order, ...(sprintDay ? { sprintDay } : {}) });

export const KANA: KanaEntry[] = [
  kana('あ', 'a', 0, 'a', 1), kana('い', 'i', 1, 'a', 1), kana('う', 'u', 2, 'a', 1), kana('え', 'e', 3, 'a', 1), kana('お', 'o', 4, 'a', 1),
  kana('か', 'ka', 5, 'ka', 1), kana('き', 'ki', 6, 'ka', 1), kana('く', 'ku', 7, 'ka', 1), kana('け', 'ke', 8, 'ka', 1), kana('こ', 'ko', 9, 'ka', 1),
  kana('さ', 'sa', 10, 'sa', 2), kana('し', 'shi', 11, 'sa', 2), kana('す', 'su', 12, 'sa', 2), kana('せ', 'se', 13, 'sa', 2), kana('そ', 'so', 14, 'sa', 2),
  kana('た', 'ta', 15, 'ta', 2), kana('ち', 'chi', 16, 'ta', 2), kana('つ', 'tsu', 17, 'ta', 2), kana('て', 'te', 18, 'ta', 2), kana('と', 'to', 19, 'ta', 2),
  kana('ら', 'ra', 30, 'ra', 5), kana('り', 'ri', 31, 'ra', 5), kana('わ', 'wa', 35, 'wa', 5), kana('を', 'wo', 36, 'wa', 5),
  kana('が', 'ga', 50, 'ga', undefined, 'hiragana', 'dakuten'), kana('きゃ', 'kya', 70, 'kya', undefined, 'hiragana', 'yoon'),
  kana('ア', 'a', 100, 'a', 8, 'katakana'), kana('イ', 'i', 101, 'a', 8, 'katakana'), kana('テ', 'te', 118, 'ta', 9, 'katakana'),
  kana('レ', 're', 133, 'ra', 12, 'katakana'), kana('ビ', 'bi', 160, 'ba', undefined, 'katakana', 'dakuten'),
];
KANA[11].altRomaji = ['si'];
KANA[23].altRomaji = ['o'];

/** The kana taught on course days 1–2 (あ, か, さ, た rows). */
export const TAUGHT_DAY_3 = new Set(KANA.filter((k) => k.sprintDay && k.sprintDay <= 2).map((k) => k.char));

const kanjiEntry = (char: string, meanings: string[], kun: string[], on: string[], components: string[] = [], parts: string[] = [], strokeCount = 4): KanjiEntry =>
  ({ char, meanings, kun, on, strokeCount, components, parts });

export const KANJI: Record<string, KanjiEntry> = {
  水: kanjiEntry('水', ['water'], ['みず'], ['スイ']),
  日: kanjiEntry('日', ['day', 'sun'], ['ひ'], ['ニチ']),
  本: kanjiEntry('本', ['book', 'origin'], ['もと'], ['ホン'], ['木']),
  木: kanjiEntry('木', ['tree', 'wood'], ['き'], ['モク', 'ボク']),
  人: kanjiEntry('人', ['person'], ['ひと'], ['ジン']),
  休: kanjiEntry('休', ['rest'], ['やす.む'], ['キュウ'], ['人', '木'], ['亻'], 6),
  池: kanjiEntry('池', ['pond'], ['いけ'], ['チ'], [], ['氵'], 6),
  曜: kanjiEntry('曜', ['weekday'], [], ['ヨウ'], ['日'], [], 18),
  食: kanjiEntry('食', ['eat', 'food'], ['た.べる'], ['ショク'], [], [], 9),
};

export const RADICALS: RadicalEntry[] = [
  { char: '氵', name: 'water (side)', meaning: 'water', variantOf: '水' },
  { char: '亻', name: 'person (side)', meaning: 'person', variantOf: '人' },
];

const word = (id: string, written: string, kanaReading: string, meanings: string[], kanji: string[], extra: Partial<WordEntry> = {}): WordEntry =>
  ({ id, written, kana: kanaReading, meanings, pos: ['n'], freqRank: 10, kanji, ...extra });

export const WORDS: WordEntry[] = [
  word('w-mizu', '水', 'みず', ['water'], ['水']),
  word('w-sui', '水曜日', 'すいようび', ['Wednesday'], ['水', '曜', '日']),
  word('w-nihon', '日本', 'にほん', ['Japan'], ['日', '本']),
  word('w-hon', '本', 'ほん', ['book'], ['本']),
  word('w-ki', '木', 'き', ['tree'], ['木']),
  word('w-hito', '人', 'ひと', ['person'], ['人']),
  word('w-yasumi', '休み', 'やすみ', ['rest', 'holiday'], ['休'], { use: true }),
  word('w-ike', '池', 'いけ', ['pond'], ['池']),
  word('w-terebi', 'テレビ', 'テレビ', ['television'], []),
];

const core = (id: string, order: number, kanaReading: string, en: string, pos: CoreWord['pos'], extra: Partial<CoreWord> = {}): CoreWord =>
  ({ id, order, kana: kanaReading, en, pos, register: 'both', topic: 'basics', use: true, kanji: [], unit: 1, ...extra });

export const CORE: CoreWord[] = [
  core('cw-0001', 1, 'ありがとう', 'thank you', 'expression'),
  core('cw-0002', 2, 'たべる', 'to eat', 'verb-ru', { written: '食べる', kanji: ['食'], register: 'plain' }),
  core('cw-0003', 3, 'もう', 'already', 'adverb', { use: false }),
  core('cw-0004', 4, 'げんき', 'healthy; well', 'adj-na', { written: '元気', kanji: ['元', '気'] }),
  core('cw-0005', 5, 'のむ', 'to drink', 'verb-u'),
  core('cw-0006', 6, 'みる', 'to see', 'verb-ru'),
];

export const CURRICULUM: Curriculum = {
  version: 2,
  units: [
    { index: 0, char: '水', anchor: 'word:w-mizu', staged: ['word:w-sui'], inferable: false, chapter: 1 },
    { index: 1, char: '日', anchor: 'word:w-nihon', staged: [], inferable: false, chapter: 1 },
    { index: 2, char: '木', anchor: 'word:w-ki', staged: [], inferable: false, chapter: 1 },
    { index: 3, char: '人', anchor: 'word:w-hito', staged: [], inferable: false, chapter: 1 },
    { index: 4, char: '休', anchor: 'word:w-yasumi', staged: [], inferable: true, chapter: 1 },
    { index: 5, char: '池', anchor: 'word:w-ike', staged: [], inferable: false, chapter: 1 },
    { index: 6, char: '曜', anchor: null, staged: [], inferable: false, chapter: 1 },
  ],
  confusables: [],
};

const examples = (n: number) => Array.from({ length: n }, (_, i) => ({ jp: `れい${i}です。`, en: `Example ${i}.` }));

export const GRAMMAR: GrammarPoint[] = [
  {
    id: 'wa-desu',
    order: 1,
    level: 'N5',
    title: '〜は〜です — "X is Y"',
    pattern: '〜は〜です',
    register: 'polite',
    prerequisites: [],
    contrastWith: ['ga-subject'],
    explanation: 'X は Y です means "X is Y".',
    examples: [
      { jp: 'わたしはがくせいです。', en: 'I am a student.' },
      { jp: '{水|みず}です。', en: 'It is water.' },
      { jp: 'これはほんです。', en: 'This is a book.' },
      ...examples(6),
    ],
    buildItems: [
      { en: 'I am a student.', jp: 'わたしはがくせいです。', tiles: ['わたし', 'は', 'がくせい', 'です'], alternatives: [], answers: ['わたしはがくせいです', 'わたしわがくせいです'] },
      { en: 'It is a book.', jp: 'ほんです。', tiles: ['ほん', 'です'], alternatives: ['これはほんです。'], answers: ['ほんです', 'これはほんです', 'これわほんです'] },
      { en: 'Tanaka is a teacher.', jp: 'たなかさんはせんせいです。', tiles: ['たなかさん', 'は', 'せんせい', 'です'], alternatives: [], answers: ['たなかさんはせんせいです', 'たなかさんわせんせいです'] },
    ],
    drills: [
      { prompt: 'わたし＿＿がくせいです。', options: ['を', 'は', 'か'], answer: 1, en: 'I am a student.' },
      { prompt: 'つまはせんせい＿＿。', options: ['は', 'を', 'です'], answer: 2, en: 'My wife is a teacher.' },
      { prompt: 'きょう＿＿げつようびです。', options: ['は', 'へ', 'を'], answer: 0, en: 'Today is Monday.' },
    ],
    unit: 1,
  },
  {
    id: 'ga-subject',
    order: 2,
    level: 'N5',
    title: '〜が — subject marker',
    pattern: '〜が',
    register: 'both',
    prerequisites: ['wa-desu'],
    contrastWith: ['wa-desu'],
    explanation: 'が marks the subject.',
    examples: examples(8),
    buildItems: [],
    drills: [],
    unit: 2,
  },
  {
    id: 'tai',
    order: 3,
    level: 'N5',
    title: '〜たい — "want to"',
    pattern: '〜たい',
    register: 'both',
    prerequisites: ['wa-desu'],
    contrastWith: [],
    explanation: 'Verb stem + たい: want to.',
    examples: examples(8),
    buildItems: [{ en: 'I want to eat.', jp: 'たべたい。', tiles: ['たべ', 'たい'], alternatives: [], answers: ['たべたい'] }],
    drills: [],
    unit: 3,
  },
];

const t = (s: string, k: PreToken['k'], ref?: PreToken['ref'], r?: string, ph?: number): PreToken =>
  ({ s, k, ...(ref ? { ref } : {}), ...(r ? { r } : {}), ...(ph !== undefined ? { ph } : {}) });

export const SENTENCES: SentenceEntry[] = [
  { id: 's-mizu', jp: '{水|みず}です。', en: 'It is water.', grammar: ['wa-desu'], tokens: [t('水', 'c', 'word:w-mizu', 'みず'), t('です', 'f'), t('。', 'p')], refs: ['word:w-mizu'], unit: 1 },
  { id: 's-nihon', jp: '{日本|にほん}の{本|ほん}です。', en: 'It is a Japanese book.', grammar: ['wa-desu'],
    tokens: [t('日本', 'c', 'word:w-nihon', 'にほん'), t('の', 'f'), t('本', 'c', 'word:w-hon', 'ほん'), t('です', 'f'), t('。', 'p')], refs: ['word:w-nihon', 'word:w-hon'], unit: 1 },
  { id: 's-arigato', jp: 'ありがとう。', en: 'Thank you.', grammar: [], tokens: [t('ありがとう', 'c', 'core:cw-0001'), t('。', 'p')], refs: ['core:cw-0001'], unit: 1 },
  { id: 's-nomu', jp: '{水|みず}をのむ。', en: 'I drink water.', grammar: [], tokens: [t('水', 'c', 'word:w-mizu', 'みず'), t('を', 'f'), t('のむ', 'c', 'core:cw-0005'), t('。', 'p')], refs: ['word:w-mizu', 'core:cw-0005'], unit: 1 },
];

export const STORIES: StoryEntry[] = [{
  id: 'st-l0-01',
  level: 'L0',
  unit: 1,
  title: 'Water',
  titleJp: '{水|みず}',
  topic: 'home',
  grammar: ['wa-desu'],
  sentences: [
    { jp: '{水|みず}です。', en: 'It is water.', phrases: ['{水|みず}です。'], tokens: [t('水', 'c', 'word:w-mizu', 'みず', 0), t('です', 'f', undefined, undefined, 0), t('。', 'p', undefined, undefined, 0)] },
    { jp: '{日本|にほん}の{本|ほん}です。', en: 'It is a Japanese book.', phrases: ['{日本|にほん}の', '{本|ほん}です。'],
      tokens: [t('日本', 'c', 'word:w-nihon', 'にほん', 0), t('の', 'f', undefined, undefined, 0), t('本', 'c', 'word:w-hon', 'ほん', 1), t('です', 'f', undefined, undefined, 1), t('。', 'p', undefined, undefined, 1)] },
  ],
  gist: { q: 'What is the story about?', options: ['Water and a book', 'A dog', 'The weather'], answer: 0 },
  chars: 13,
  refs: ['word:w-mizu', 'word:w-nihon', 'word:w-hon'],
}];

export const KANA_RULES: KanaRule[] = [{
  id: 'hira-dakuten',
  day: 6,
  script: 'hiragana',
  title: 'Voiced sounds: ゛ and ゜',
  explanation: 'Two small marks make a sound voiced.',
  pairs: [{ from: 'か', to: 'が', romaji: 'ga' }, { from: 'さ', to: 'ざ', romaji: 'za' }],
  practiceWords: [
    { kana: 'かぎ', en: 'key' }, { kana: 'ちず', en: 'map' }, { kana: 'かぜ', en: 'wind' }, { kana: 'ごご', en: 'afternoon' },
    { kana: 'ひざ', en: 'knee' }, { kana: 'でんわ', en: 'phone' }, { kana: 'ぶた', en: 'pig' }, { kana: 'えんぴつ', en: 'pencil' },
  ],
}];

/** Hand-picked kana examples (kana-examples.json) with picture hooks. */
export const KANA_EXAMPLES: Record<string, KanaExample> = {
  あ: { kana: 'あめ', written: '雨', en: 'rain', hook: 'An apple with a stem and a leaf.' },
  か: { kana: 'かさ', written: '傘', en: 'umbrella', hook: 'A kite with its tail.' },
  い: { kana: 'いけ', written: '池', en: 'pond', hook: 'Two eels side by side.' },
  を: { kana: 'をかし', en: 'charming', hook: 'A wobbly person.' },
  ア: { kana: 'アイス', en: 'ice cream', hook: 'An axe.' },
};

export const MNEMONICS: MnemonicsFile = { 水: { meaning: 'A stream splashing drops to both sides: water.', sound: 'Me-zoo drinks water.' } };

export const ACCENT: AccentFile = {
  'word:w-mizu': { moras: ['ミ', 'ズ'], drop: 0, type: 'heiban', withGa: true },
  'word:w-hon': { moras: ['ホ', 'ン'], drop: 1, type: 'atamadaka', withGa: true },
  'core:cw-0001': { moras: ['ア', 'リ', 'ガ', 'ト', 'ー'], drop: 2, type: 'nakadaka' },
};

export const MANIFEST: AudioManifest = {
  version: 1,
  generatedAt: '2026-10-15',
  engine: 'VOICEVOX test',
  credits: ['VOICEVOX:No.7'],
  clips: { c1: { file: 'c1/c1.m4a', ms: 1200, voice: 'f', pack: 'u01', via: 'text', accentPhrases: [['ミズデス', 2]] } },
  byRef: { 'sentence:s-mizu': 'c1' },
  byText: {},
};

const ready = <T extends object>(o: T) => ({ ...o, ready: true });
export const UNITS: UnitSpec[] = [{
  id: 1,
  title: 'Hello',
  titleJp: 'こんにちは',
  level: 'A1',
  topic: 'greetings',
  grammar: ['wa-desu'],
  coreWordCeiling: 40,
  canDos: [
    ready({ id: 'u01-cd1', text: 'Read a simple menu', check: { kind: 'read' as const, instructions: 'Read the menu.', material: 'コーヒー 300{円|えん}', questions: [
      { q: 'What costs 300 yen?', options: ['Coffee', 'Tea', 'Cake'], answer: 0 },
      { q: 'Is it a drink?', options: ['Yes', 'No'], answer: 0 },
      { q: 'How much?', options: ['100 yen', '300 yen'], answer: 1 },
    ] } }),
    ready({ id: 'u01-cd2', text: 'Understand a short message', check: { kind: 'listen' as const, instructions: 'Listen.', material: 'あしたはやすみです。', questions: [
      { q: 'When?', options: ['Tomorrow', 'Today'], answer: 0 },
      { q: 'What?', options: ['A day off', 'Work'], answer: 0 },
    ] } }),
    ready({ id: 'u01-cd3', text: 'Introduce yourself', check: { kind: 'speak' as const, instructions: 'Say who you are.', material: '', questions: [], rubric: ['Says their name', 'Uses です'] } }),
    { id: 'u01-cd4', text: 'Write a note', check: { kind: 'write' as const, instructions: '', material: '', questions: [] }, ready: false },
  ],
  conversation: 'rp-u01',
  task: { id: 't-u01', canDo: 'u01-cd3', goal: '', outcomeQuestion: '', roles: { a: '', b: '' }, infoA: '', infoB: '', targets: [], register: 'polite', twist: '', scripted: [], ready: false },
  capstone: { title: '', brief: '', minLinesEach: 2, structures: [] },
}];

/** Simple straight strokes are enough: the real WritingPad is mocked. */
const lines = (n: number) => Array.from({ length: n }, (_, i) => `M${20 + i * 10} 20L${20 + i * 10} 90`);
export const STROKES: Record<string, string[]> = {
  あ: lines(3), い: lines(2), う: lines(2), し: lines(1), か: lines(3), を: lines(3), ア: lines(2),
  水: lines(4), 日: lines(4), 木: lines(4), 人: lines(2), 休: lines(6), 池: lines(6), 本: lines(5), 曜: lines(18), 氵: lines(3),
};

function wordInfos(): (ref: string) => WordInfo | undefined {
  const infos = new Map<string, WordInfo>();
  for (const c of CORE) {
    infos.set(`core:${c.id}`, {
      ref: `core:${c.id}`, written: c.written ?? c.kana, kana: c.kana, en: c.en, kanji: c.kanji, use: c.use,
      readings: [c.kana, ...(c.altKana ?? [])], register: c.register, ...(c.note ? { note: c.note } : {}), core: c,
    });
  }
  for (const w of WORDS) {
    infos.set(`word:${w.id}`, {
      ref: `word:${w.id}`, written: w.written, kana: w.kana, en: w.meanings.join('; '), kanji: w.kanji, use: w.use ?? false,
      readings: [w.kana, ...(w.altKana ?? [])], entry: w,
    });
  }
  return (ref) => infos.get(ref);
}

export const dataMock = {
  EMPTY_MANIFEST: { version: 1, generatedAt: '', engine: '', credits: [], clips: {}, byRef: {}, byText: {} },
  loadKana: async () => KANA,
  loadKanji: async () => KANJI,
  loadRadicals: async () => RADICALS,
  loadWords: async () => WORDS,
  loadWordIndex: async () => new Map(WORDS.map((w) => [w.id, w])),
  loadCoreWords: async () => CORE,
  loadCoreIndex: async () => new Map(CORE.map((c) => [c.id, c])),
  loadWordInfo: async () => wordInfos(),
  loadCurriculum: async () => CURRICULUM,
  loadStrokes: async () => STROKES,
  strokesFor: async (char: string) => STROKES[char],
  loadMnemonics: async () => MNEMONICS,
  loadGrammar: async () => GRAMMAR,
  loadGrammarIndex: async () => new Map(GRAMMAR.map((g) => [g.id, g])),
  loadSentences: async () => SENTENCES,
  loadStories: async () => STORIES,
  loadRolePlays: async () => [],
  loadUnits: async () => UNITS,
  loadKanaExamples: async () => KANA_EXAMPLES,
  loadKanaRules: async () => KANA_RULES,
  loadAccent: async () => ACCENT,
  loadAudioManifest: async () => MANIFEST,
  audioUrl: (file: string) => `/audio/${file}`,
  clearDataCache: () => {},
};

const ok: PlayResult = { via: 'none', ms: 0, interrupted: false };
/** Audio that records what it was asked to play and finishes at once. */
export const audioMock = {
  play: vi.fn(async (_source: unknown, _opts?: unknown): Promise<PlayResult> => ok),
  stopAudio: vi.fn(),
  hasClip: vi.fn(async () => true),
  setDefaultAudioRate: vi.fn(),
  getDefaultAudioRate: () => 0.85,
  packsFor: vi.fn(() => ['misc']),
  prefetchPacks: vi.fn(async () => 0),
  installAudioUnlock: () => () => {},
  usePlayback: () => ({ play: audioMock.play, stop: audioMock.stopAudio, playing: false }),
};

const match = (over: Partial<UnorderedMatch> = {}, n = 1): UnorderedMatch =>
  ({ ok: true, missing: [], extra: [], unmatched: [], orderSlips: [], assignment: Array.from({ length: n }, (_, i) => i), ...over });

/**
 * Stand-in for the canvas. Trace/guided/memory: buttons finish the character cleanly, draw the next stroke right or
 * miss one. Recall: buttons report the whole character written right, with a stroke missing, or with one stroke off.
 */
const MockWritingPad = forwardRef<WritingPadHandle, WritingPadProps>(function MockWritingPad(
  { strokes, mode, label, onStrokeResult, onComplete, onRecallDone, disabled },
  ref,
) {
  const done = useRef(0);
  const result = { mistakes: 0, hintsUsed: 0, strokeCount: strokes.length, gaveUp: false, failedStrokes: 0 };
  const n = strokes.length;
  const recall = (m: UnorderedMatch) => onRecallDone?.({ strokes: [], match: m, hintUsed: false });
  useImperativeHandle(ref, () => ({
    undo() {
      done.current = Math.max(0, done.current - 1);
    },
    clear() {
      done.current = 0;
    },
    hint() {},
    giveUp() {
      onComplete?.({ ...result, gaveUp: true, failedStrokes: strokes.length });
    },
    done() {
      recall(match({}, n));
    },
  }));
  if (mode === 'recall') {
    return (
      <div role="img" aria-label={`Writing pad for ${label} (recall)`} data-mode={mode}>
        <button type="button" disabled={disabled} onClick={() => recall(match({}, n))}>Write it right</button>
        <button type="button" disabled={disabled} onClick={() => recall(match({ ok: false, missing: [n - 1] }, n))}>Leave a stroke out</button>
        <button type="button" disabled={disabled} onClick={() => recall(match({ ok: false, unmatched: [0] }, n))}>Write one stroke badly</button>
      </div>
    );
  }
  return (
    <div role="img" aria-label={`Writing pad for ${label} (${mode})`} data-mode={mode}>
      <button type="button" disabled={disabled} onClick={() => onComplete?.(result)}>Finish writing</button>
      <button type="button" disabled={disabled} onClick={() => onStrokeResult?.(done.current++, true, { ok: true, score: 0.9 })}>
        Draw a stroke
      </button>
      <button type="button" disabled={disabled}
        onClick={() => onStrokeResult?.(done.current, false, { ok: false, score: 0.2, reason: 'direction' })}>
        Miss a stroke
      </button>
      <button type="button" disabled={disabled}
        onClick={() => onStrokeResult?.(done.current, false, { ok: false, score: 0.2, reason: 'shape' })}>
        Miss the shape
      </button>
    </div>
  );
});

export const writingPadMock = { WritingPad: MockWritingPad, AUTO_HINT_AFTER: 2 };

/** Empties every table and per-device storage, then stores settings for an onboarded learner. */
export async function resetStudyDb(settings: Partial<Settings> = {}): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
  localStorage.clear();
  await db.settings.put({ ...DEFAULT_SETTINGS, onboarded: true, audio: false, ...settings, id: 'me' });
}
