// Shared data contracts for Issho. Static data lives in public/data (built by
// scripts/build-data.ts from KanjiVG, KANJIDIC2, JMdict and content/*.json).
// Per-device progress lives in IndexedDB (src/lib/db.ts).

import type { Card as FsrsCard, Grade } from 'ts-fsrs';

// ---------------------------------------------------------------------------
// Static data: public/data/*.json
// ---------------------------------------------------------------------------

/** SVG path data for each stroke, in stroke order, in KanjiVG's 109×109 box. */
export type StrokePaths = string[];

/** public/data/strokes.json */
export type StrokesFile = Record<string, StrokePaths>;

export type KanaScript = 'hiragana' | 'katakana';
export type KanaKind = 'basic' | 'dakuten' | 'handakuten' | 'yoon';

/** public/data/kana.json is KanaEntry[] in teaching order. */
export interface KanaEntry {
  char: string;            // 'あ', 'きゃ'
  script: KanaScript;
  romaji: string;          // Hepburn: 'a', 'shi', 'kya'
  /** Row id used to group lessons: 'a', 'ka', 'sa', ... 'ga', 'pa', 'kya' */
  group: string;
  kind: KanaKind;
  /** Teaching order within the whole kana course (0-based). */
  order: number;
  /** Romaji alternatives accepted when typing ('si' for し, 'tu' for つ). */
  altRomaji?: string[];
}

/** public/data/kanji.json is Record<char, KanjiEntry> for every curriculum kanji. */
export interface KanjiEntry {
  char: string;
  meanings: string[];      // English, most important first (max 4)
  on: string[];            // katakana, e.g. ['スイ']
  kun: string[];           // hiragana, '.' marks okurigana, e.g. ['みず', 'た.べる']
  strokeCount: number;
  grade?: number;          // school grade 1-6, 8 = secondary jōyō
  /** Old JLPT level from KANJIDIC2 (4 = easiest). */
  jlptOld?: number;
  /** Newspaper frequency rank 1..2500 (lower = more common). */
  freq?: number;
  /** Visual components (from KanjiVG) that are taught before this kanji. */
  components: string[];
}

/** content/radicals.json and public/data/radicals.json */
export interface RadicalEntry {
  char: string;            // '氵'
  name: string;            // 'water (side)'
  meaning: string;         // short gloss used in quizzes
  /** Full kanji this is a variant of, if any ('水' for '氵'). */
  variantOf?: string;
}

/** public/data/words.json is WordEntry[] (common JMdict words using curriculum kanji). */
export interface WordEntry {
  id: string;              // JMdict ent_seq
  written: string;         // '水曜日'
  kana: string;            // 'すいようび'
  meanings: string[];      // first sense glosses, max 3
  pos: string[];           // short part-of-speech tags, e.g. ['n'], ['v1', 'vt']
  /** 1 (most common) .. 48 from JMdict nfXX, 49 = common without nf, 99 = other. */
  freqRank: number;
  kanji: string[];         // distinct kanji chars in `written`
}

export type UnitType = 'radical' | 'kanji';

/** public/data/curriculum.json */
export interface Curriculum {
  units: CurriculumUnit[];
  /** Unit index (exclusive) where each phase ends: { 2: 330, 3: 900 } etc. */
  phaseEnds: Record<string, number>;
}

export interface CurriculumUnit {
  index: number;           // 0-based teaching order
  type: UnitType;
  char: string;
  /** Word ids (WordEntry.id) introduced with this unit, max 3. Empty for radicals. */
  words: string[];
  /** Phase this unit belongs to: 2, 3 or 4. (Phase 1 is kana.) */
  phase: number;
}

/**
 * Ruby markup used in all authored Japanese text:
 *   "{明日|あした}は{水曜日|すいようび}です。"
 * Braces wrap a base with its kana reading. Text outside braces is shown as-is.
 * Parse with src/lib/ruby.ts.
 */
export type RubyText = string;

/** content/survival-words.json — kana-first words taught during phase 1. */
export interface SurvivalWord {
  id: string;              // 'sw-arigatou'
  kana: string;            // 'ありがとう'
  written?: string;        // kanji form for later, if any: '有難う' (rarely shown)
  en: string;
  note?: string;
}

/** content/mnemonics.json: Record<char, string> (one short line each). */
export type MnemonicsFile = Record<string, string>;

export interface GrammarExample { jp: RubyText; en: string }

export interface GrammarDrill {
  /** Sentence with one blank written as ＿＿ (two full-width low lines). */
  prompt: RubyText;
  options: string[];       // 3-4 options, plain kana
  answer: number;          // index into options
  en: string;              // translation of the completed sentence
}

/** content/grammar.json is GrammarPoint[] sorted by `order`. */
export interface GrammarPoint {
  id: string;              // 'wa-desu'
  order: number;
  phase: 1 | 2 | 3 | 4;
  title: string;           // 'X は Y です — "X is Y"'
  pattern: RubyText;       // '〜は〜です'
  explanation: string;     // 2-4 plain-English sentences
  examples: GrammarExample[];  // 3+
  drills: GrammarDrill[];      // 4+
}

/** content/sentences.json is SentenceEntry[]. */
export interface SentenceEntry {
  id: string;              // 's-0001'
  jp: RubyText;
  en: string;
  /** Grammar point ids this sentence exercises. */
  grammar?: string[];
}

export interface RolePlayLine { role: 'a' | 'b'; jp: RubyText; en: string; hint?: string }

/** content/roleplays.json is RolePlay[]. */
export interface RolePlay {
  id: string;
  title: string;           // 'At the café'
  titleJp: RubyText;
  level: 1 | 2 | 3;
  setting: string;         // one English sentence
  roles: { a: { name: string; nameJp: RubyText }; b: { name: string; nameJp: RubyText } };
  lines: RolePlayLine[];
}

// ---------------------------------------------------------------------------
// Progress: IndexedDB
// ---------------------------------------------------------------------------

/**
 * What can be learned. Item ids:
 *   kana:あ  radical:氵  kanji:水  word:<jmdict id>  vocab:<survival id>
 *   grammar:<id>  sentence:<id>
 */
export type ItemKind = 'kana' | 'radical' | 'kanji' | 'word' | 'vocab' | 'grammar' | 'sentence';

export interface ItemRecord {
  id: string;              // `${kind}:${key}`
  kind: ItemKind;
  key: string;             // the char / id after the colon
  introducedAt: Date;
  /** User-edited memory hook (overrides content/mnemonics.json). */
  customMnemonic?: string;
  hideMnemonic?: boolean;
}

/**
 * Card types per item kind:
 *   kana:    read (see kana → romaji), write (romaji → draw kana; not for yōon)
 *   radical: meaning
 *   kanji:   meaning, reading (kanji → pick an on/kun reading), write (meaning → draw)
 *   word:    reading (word → kana), meaning (word → English)
 *   vocab:   meaning (kana → English), recall (English → kana)
 *   grammar: drill
 *   sentence: read (self-graded)
 */
export type CardType = 'read' | 'write' | 'meaning' | 'reading' | 'recall' | 'drill';

export interface CardRecord extends FsrsCard {
  id: string;              // `${itemId}|${cardType}`
  itemId: string;
  kind: ItemKind;
  type: CardType;
  /** Suspended cards are never scheduled. */
  suspended?: boolean;
}

export type AnswerMode = 'choice' | 'typed' | 'written' | 'self';

export interface ReviewLogRecord {
  id?: number;             // auto-increment
  cardId: string;
  itemId: string;
  grade: Grade;            // 1 Again, 2 Hard, 3 Good, 4 Easy
  reviewedAt: Date;
  /** Time spent answering, ms. */
  durationMs: number;
  mode: AnswerMode;
  /** FSRS state before this review (ts-fsrs State). */
  prevState: number;
}

/** One row per local calendar day, key 'YYYY-MM-DD'. */
export interface DayRecord {
  date: string;
  studyMs: number;
  reviews: number;
  correct: number;         // reviews graded Hard/Good/Easy
  newItems: number;
  sessionComplete: boolean;
  /** Set when a missed day was covered by the weekly rest day. */
  restDay?: boolean;
}

export interface Settings {
  id: 'me';
  name: string;
  onboarded: boolean;
  /** New items per day (kana, radicals, kanji, vocab). */
  newPerDay: number;           // default 5
  desiredRetention: number;    // default 0.9
  /** Max reviews shown per day; the rest roll to later days. */
  maxReviewsPerDay: number;    // default 120
  furigana: 'always' | 'unknown' | 'never';  // default 'unknown'
  romaji: boolean;             // show romaji under kana, default true in phase 1 only
  audio: boolean;              // auto-play TTS, default true
  ttsVoice?: string;           // SpeechSynthesisVoice.voiceURI
  writingHand: 'finger' | 'stylus';
  /** Skip kana course: user already knows hiragana/katakana. */
  knowsHiragana: boolean;
  knowsKatakana: boolean;
  // Home server (together features)
  serverUrl?: string;          // '' = same origin
  deviceToken?: string;
  memberId?: string;
  householdName?: string;
}

/** Chat messages waiting to be sent while offline. */
export interface OutboxRecord {
  clientId: string;            // uuid
  createdAt: Date;
  kind: 'text' | 'voice';
  text: string;
  transcript?: string;
  audio?: Blob;
  attempts: number;
}

/** Local cache of chat messages (mirrors server). */
export interface ChatMessageRecord {
  id: number;                  // server id
  clientId: string;
  memberId: string;
  createdAt: string;           // ISO
  kind: 'text' | 'voice' | 'system';
  text: string;
  transcript?: string;
  audioId?: string;
}

/** Sentences the user saved from reading to review later. */
export interface SavedSentenceRecord {
  id: string;                  // SentenceEntry.id or 'custom-<uuid>'
  jp: RubyText;
  en: string;
  savedAt: Date;
}
