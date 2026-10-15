// Shared data contracts for Issho v2.
// Static data lives in public/data (scripts/build-data.ts) and public/audio (scripts/audio/generate.ts).
// Per-device progress lives in IndexedDB (src/lib/db.ts). The HTTP/WebSocket contract is shared/api.ts.

import type { Card as FsrsCard, Grade } from 'ts-fsrs';
import type {
  AiIssue,
  QuizVerdict,
  SharedGoal,
  TogetherSessionId,
  TogetherSlot,
  VoiceId,
} from '../../shared/api.ts';

export type { AiIssue, QuizVerdict, SharedGoal, TogetherSessionId, TogetherSlot, VoiceId };

// ===========================================================================
// Static data: public/data/**.json and public/audio/manifest.json
// ===========================================================================

/** SVG path data for each stroke, in stroke order, in KanjiVG's 109×109 box. */
export type StrokePaths = string[];

/** public/data/strokes.json */
export type StrokesFile = Record<string, StrokePaths>;

export type KanaScript = 'hiragana' | 'katakana';
export type KanaKind = 'basic' | 'dakuten' | 'handakuten' | 'yoon';

/**
 * public/data/kana.json: all 208 kana in chart order. Only the 92 basic kana are taught as items
 * (they have `sprintDay`); voiced kana and yōon are taught by the kana-rule lessons. The chart,
 * the romaji helper and the IME use every entry.
 */
export interface KanaEntry {
  char: string;            // 'あ', 'きゃ'
  script: KanaScript;
  romaji: string;          // Hepburn: 'a', 'shi', 'kya'
  /** Row id used to group lessons: 'a', 'ka', … ('wa' holds わ and を; 'n' holds ん). Repeats across scripts. */
  group: string;
  kind: KanaKind;
  /** Chart order within the whole kana table (0-based). */
  order: number;
  /** Romaji alternatives accepted when typing ('si' for し, 'tu' for つ). */
  altRomaji?: string[];
  /** Basic kana only: the sprint day that teaches it (hiragana 1–5, katakana 8–12). */
  sprintDay?: number;
}

export type KanaRuleId = 'hira-dakuten' | 'hira-yoon' | 'kata-dakuten-yoon' | 'kata-extended';

/** public/data/content/kana-rules.json: the four rule lessons of the kana sprint, in day order. */
export interface KanaRule {
  id: KanaRuleId;
  day: 6 | 7 | 13 | 14;
  script: KanaScript;
  title: string;           // 'Voiced sounds: ゛ and ゜'
  explanation: string;     // 2–4 plain sentences
  /** Every character of the rule: か→が 'ga'. */
  pairs: { from: string; to: string; romaji: string }[];
  /** 8 real words using only kana taught by `day`; the rule's read card cycles through them. */
  practiceWords: { kana: string; en: string }[];
  /**
   * Build-time, only on 'kata-extended' (the last sprint lesson): the day-14 "Kana check" can-do,
   * 10 katakana core words of topic food/drink (topped up from other katakana core words), menu order.
   */
  checkWords?: { kana: string; en: string; ref: `core:${string}` }[];
}

/** public/data/kanji.json is Record<char, KanjiEntry> for every curriculum kanji and every component. */
export interface KanjiEntry {
  char: string;
  meanings: string[];      // English, most important first (max 4); meanings[0] is the keyword
  on: string[];            // katakana
  kun: string[];           // hiragana, '.' marks okurigana
  strokeCount: number;
  grade?: number;
  /** Old JLPT level from KANJIDIC2 (4 = easiest). Shown as a label only. */
  jlptOld?: number;
  /** Newspaper frequency rank 1..2500. */
  freq?: number;
  /** Component kanji taught as kanji units before this one. */
  components: string[];
  /** Named parts (radicals.json) that are not kanji units: shown in the parts panel only. */
  parts: string[];
  /** Curriculum position, 1-based; the write-list rank. Absent for components outside the curriculum. */
  rank?: number;
}

/**
 * public/data/radicals.json: named parts. They have no unit and no cards; their name and meaning
 * show in the kanji lesson's parts panel and in the feedback after a miss.
 */
export interface RadicalEntry {
  char: string;            // '氵'
  name: string;            // 'water (side)'
  meaning: string;
  /** Full kanji this is a variant of, if any ('水' for '氵'). */
  variantOf?: string;
}

/** public/data/words.json is WordEntry[] (JMdict words using curriculum kanji). */
export interface WordEntry {
  id: string;              // JMdict ent_seq
  written: string;
  kana: string;
  meanings: string[];      // first sense glosses, max 3
  pos: string[];
  /** 1 (most common) .. 48 from JMdict nfXX, 49 = common without nf, 99 = other. */
  freqRank: number;
  kanji: string[];         // distinct kanji chars in `written`
  /** JMdict priority tags of this spelling: 'ichi1', 'spec2', 'news1', 'nf12' … */
  pri?: string[];
  /** Core word id when this entry is also a core word: the learner's item is then `core:<id>`. */
  core?: string;
  /** The learner should produce it (it appears in a role-play or task line): adds a produce card. */
  use?: boolean;
  /** Other kana accepted when typing the reading (long-vowel variants, JMdict alternates). */
  altKana?: string[];
}

/** A word taught as an item: a JMdict word or a core word. */
export type WordRef = `word:${string}` | `core:${string}`;
/** A unit/role-play target. */
export type TargetRef = `core:${string}` | `grammar:${string}`;
export type Register = 'polite' | 'plain' | 'both';

export type CorePos =
  | 'noun' | 'verb-ru' | 'verb-u' | 'verb-irr' | 'adj-i' | 'adj-na' | 'adverb' | 'particle-phrase'
  | 'expression' | 'pronoun' | 'demonstrative' | 'counter' | 'number' | 'conjunction'
  | 'interjection' | 'suffix' | 'prefix';

/** public/data/content/core-words.json: CoreWord[] in `order` (1,577 today; the count may still change). */
export interface CoreWord {
  /** 'cw-0001'. May be renumbered by content authors until release; frozen after it (ids are durable keys on
   *  the device: items, cards, pitch boxes, staged rows, partner-quiz keys). Later reorders change `order` only. */
  id: string;
  order: number;           // teaching order, 1-based, no gaps
  kana: string;            // reading: hiragana, or katakana for loanwords
  /** Usual written form when normally written with kanji ('食べる'). */
  written?: string;
  jmdict?: string;
  en: string;
  pos: CorePos;
  register: Register;
  topic: string;
  /** Learner should say/write it: adds a produce card. */
  use: boolean;
  note?: string;
  /** Old survival-words.json id it replaces. */
  survival?: string;
  /** Build-time: kanji in `written`, in order ([] for kana-only words). */
  kanji: string[];
  /** Build-time: the first unit whose coreWordCeiling covers `order`. */
  unit: number;
  /** Build-time: other accepted kana for typed answers (おう/おお variants). */
  altKana?: string[];
}

/** One kanji unit of public/data/curriculum.json. Named parts are never units. */
export interface CurriculumUnit {
  /** 0-based teaching order. `index + 1` is KanjiEntry.rank. */
  index: number;
  char: string;
  /** Taught with the kanji; its write prompt shows this word with the kanji blanked. Null for zero-word kanji. */
  anchor: WordRef | null;
  /** Released 3 and 8 calendar days after the kanji (max 2; released on the first study day on or after that
   *  date). A core ref already introduced becomes a spelling upgrade. */
  staged: WordRef[];
  /** Every component is known and the meaning is semantic (休, 明, 林): offer the 5-s pre-guess. */
  inferable: boolean;
  /** Chapter number, 1-based, 15 kanji each (chapter 0 is kana). */
  chapter: number;
}

export interface ConfusableSet {
  id: string;              // 'v-未末', 'm-numbers'
  chars: string[];
  /** visual: members ≥ 5 study days apart; meaning (numbers, weekdays): at most 3 members per day. */
  kind: 'visual' | 'meaning';
}

/** public/data/curriculum.json */
export interface Curriculum {
  version: 2;
  units: CurriculumUnit[];
  confusables: ConfusableSet[];
}

/**
 * Ruby markup used in all authored Japanese text: "{明日|あした}は{水曜日|すいようび}です。"
 * Parse with src/lib/ruby.ts.
 */
export type RubyText = string;

/** public/data/content/mnemonics.json values. Never shown as the cue during a test. */
export interface MnemonicEntry {
  /** One sentence, ≤ 20 words, built only from part names met earlier. */
  meaning: string;
  /** Sound hook for the anchor word's reading. */
  sound?: string;
}
export type MnemonicsFile = Record<string, MnemonicEntry>;

export interface GrammarExample { jp: RubyText; en: string }

/** Lesson practice only (no longer a review card). */
export interface GrammarDrill {
  prompt: RubyText;        // one blank written as ＿＿
  options: string[];
  answer: number;
  en: string;
}

export interface GrammarBuildItem {
  en: string;
  jp: RubyText;
  /** jp split into 3–7 chunks in order (plain text, kanji allowed). */
  tiles: string[];
  /** Other fully acceptable answers, plain text. */
  alternatives: string[];
  /** Build-time: accepted typed answers as hiragana (jp and alternatives, with は/わ, へ/え, を/お variants). */
  answers: string[];
}

/** public/data/content/grammar.json is GrammarPoint[] sorted by `order` (about 115). */
export interface GrammarPoint {
  id: string;              // kebab-case: 'wa-desu'
  order: number;
  level: 'N5' | 'N4';
  title: string;
  pattern: RubyText;
  register: Register;
  /** Passive/causative/keigo set phrases: comprehend card only. */
  recognitionOnly?: boolean;
  /** Direct prerequisites (ids). The only gate on teaching it. */
  prerequisites: string[];
  /** Easily confused points: taught ≥ 5 study days apart. */
  contrastWith: string[];
  explanation: string;
  examples: GrammarExample[];      // ≥ 8
  buildItems: GrammarBuildItem[];  // ≥ 4 (0 when recognitionOnly)
  drills: GrammarDrill[];          // ≥ 4, lesson practice
  /** Build-time: UnitSpec.id that teaches it. */
  unit: number;
}

/** A pre-tokenised word of a sentence or story (scripts/v2/tokenize.ts at build time). */
export interface PreToken {
  /** Surface as written, no ruby. */
  s: string;
  /** Hiragana reading, present when the surface has kanji. */
  r?: string;
  /** The item it belongs to (content words found in the core list or JMdict). */
  ref?: WordRef;
  /** 'c' content word, 'f' function (particle, auxiliary, prefix…), 'p' punctuation or space. */
  k: 'c' | 'f' | 'p';
  /** A person or place name: never counted for coverage, always shown with its reading. */
  name?: true;
  /** 0-based phrase index ('／' breaks). Stories only. */
  ph?: number;
}

/** public/data/content/sentences.json: fixed i+1 study sentences. */
export interface SentenceEntry {
  id: string;              // 's-s1-001'
  jp: RubyText;
  en: string;
  /** grammar-v2 ids the sentence uses (all must be introduced before it is picked). */
  grammar: string[];
  tokens: PreToken[];
  /** Distinct content refs in the sentence. */
  refs: WordRef[];
  /** Build-time: the highest unit of its grammar tags and of its core refs (CoreWord.unit); 1 when none. Its audio pack. */
  unit: number;
}

export type StoryLevel = 'start' | 'L0' | 'L1';

export interface StorySentence {
  jp: RubyText;            // without '／'
  en: string;
  tokens: PreToken[];      // with `ph`
  /** The sentence's phrases (ruby), split at the author's '／' marks. */
  phrases: RubyText[];
}

/** public/data/content/stories.json: StoryEntry[] sorted by level then id. */
export interface StoryEntry {
  id: string;              // 'st-l0-07'
  level: StoryLevel;
  unit: number;
  title: string;
  titleJp: RubyText;
  topic: string;
  grammar: string[];
  sentences: StorySentence[];
  gist: { q: string; options: string[]; answer: number };
  /** Characters with ruby, phrase marks and spaces removed (for characters per minute). */
  chars: number;
  /** Distinct content refs. */
  refs: WordRef[];
}

export interface RolePlayLine {
  role: 'a' | 'b';
  jp: RubyText;
  en: string;
  hint?: string;
  /** 2–4 English keywords for the cue-card stage (S4); '' in upgraded v1 scripts. */
  cue: string;
}

/**
 * public/data/content/roleplays.json: core conversations and free role-plays. A **core conversation** is a
 * script that some UnitSpec.conversation names (rp-u01…rp-u25 today); every other script is a free role-play.
 */
export interface RolePlay {
  id: string;
  /** The unit it fits (level gate): offered once the couple reached this unit. Not what makes it a core conversation. */
  unit?: number;
  title: string;
  titleJp: RubyText;
  setting: string;
  level: 1 | 2 | 3;
  register: 'polite' | 'plain' | 'mixed';
  targets: TargetRef[];
  roles: { a: { name: string; nameJp: RubyText }; b: { name: string; nameJp: RubyText } };
  lines: RolePlayLine[];
}

export type CanDoCheckKind = 'read' | 'listen' | 'speak' | 'write';

export interface CanDoQuestion { q: string; options: string[]; answer: number }

export interface CanDo {
  id: string;              // 'u03-cd2'
  text: string;
  check: {
    kind: CanDoCheckKind;
    instructions: string;
    /** Menu/sign/message, or the TTS script for listen. */
    material: RubyText;
    /** read/listen: 2–3 questions. */
    questions: CanDoQuestion[];
    /** speak/write: 2–4 observable criteria. */
    rubric?: string[];
  };
  /** Build-time: the check has its material and questions (or rubric). False while content is in progress. */
  ready: boolean;
}

export interface TaskCard {
  id: string;
  canDo: string;
  goal: string;
  outcomeQuestion: string;
  roles: { a: string; b: string };
  infoA: string;
  infoB: string;
  targets: TargetRef[];
  register: 'polite' | 'plain' | 'mixed';
  twist: string;
  aiRole?: string;
  /** Offline fallback script, 8–14 lines. */
  scripted: { role: 'a' | 'b'; jp: RubyText; en: string }[];
  /** Build-time: goal, info halves and script present. */
  ready: boolean;
}

/** public/data/content/units.json: UnitSpec[] by id (25). */
export interface UnitSpec {
  id: number;
  title: string;
  titleJp: RubyText;
  level: 'A1' | 'A2' | 'N3-path';
  topic: string;
  /** grammar-v2 ids taught in this unit, in order (units partition grammar). */
  grammar: string[];
  coreWordCeiling: number;
  canDos: CanDo[];
  /** RolePlay id of its core conversation. */
  conversation: string;
  task: TaskCard;
  capstone: { title: string; brief: string; minLinesEach: number; structures: string[] };
}

export type AccentType = 'heiban' | 'atamadaka' | 'nakadaka' | 'odaka';

export interface AccentInfo {
  /** Moras of the expected reading in katakana, long vowels kept as ー: ['コ','ー','ヒ','ー']. */
  moras: string[];
  /** Accent nucleus: 0 = heiban (no drop), n = the pitch drops after mora n (1-based). */
  drop: number;
  type: AccentType;
  /** Measured with が after the word (noun-like words); the 'pitch:<ref>' clip carries exactly this query. */
  withGa?: true;
}

/** public/data/accent.json: keys 'core:<id>', 'word:<id>'. Only words read from their kanji spelling or kana-only. */
export type AccentFile = Record<string, AccentInfo>;

/** One accent phrase of a sentence clip, as VOICEVOX read it: moras (katakana, joined) and the accent nucleus
 *  (1-based; equal to the mora count when the phrase has no drop inside it). Pause moras are left out. */
export type ClipAccentPhrase = [moras: string, accent: number];

export interface AudioClip {
  /** Path under public/audio: 'a3/a3f09c1e5b2d7781.m4a'. */
  file: string;
  /** Duration, ms. */
  ms: number;
  voice: VoiceId;
  /** Prefetch pack: 'kana', 'u01'…'u25', 'c01'… (kanji chapters), 'misc'. */
  pack: string;
  /** Story sentences: start offset (ms) of each '／' phrase. */
  phrases?: number[];
  /** 'text': VOICEVOX read the written text correctly; 'kana': it was given the reading. */
  via: 'text' | 'kana';
  /** Sentence-type clips (grammar examples and builds, sentences, story sentences, role-play and task lines) read
   *  via 'text' only: the accent phrases of the same audio_query, for the phrase pitch line. */
  accentPhrases?: ClipAccentPhrase[];
}

/** public/audio/manifest.json */
export interface AudioManifest {
  version: 1;
  generatedAt: string;
  /** Engine of the latest run, display only ('VOICEVOX 0.25.2'); not part of clip hashes. */
  engine: string;
  /** Shown in Settings → About: ['VOICEVOX:No.7', 'VOICEVOX:青山龍星']. */
  credits: string[];
  /** Clip id (content hash) → clip. */
  clips: Record<string, AudioClip>;
  /** Clip ref ('core:cw-0001', 'pitch:core:cw-0042', 'story:st-l0-07#3', …, see §2.2) → clip id. */
  byRef: Record<string, string>;
  /** clipTextKey(voice, text) (shared/voicevox.ts) → clip id; plain-only keys only when unambiguous (§2.2). */
  byText: Record<string, string>;
}

// ===========================================================================
// Progress: IndexedDB
// ===========================================================================

/**
 * What can be learned. Item ids:
 *   kana:あ  kanaRule:hira-dakuten  kanji:水  word:<JMdict id>  core:<core id>
 *   grammar:<id>  sentence:<saved sentence id>
 */
export type ItemKind = 'kana' | 'kanaRule' | 'kanji' | 'word' | 'core' | 'grammar' | 'sentence';
export type ItemRef = `${ItemKind}:${string}`;

export interface ItemRecord {
  id: string;              // `${kind}:${key}`
  kind: ItemKind;
  key: string;
  introducedAt: Date;
  /** How it arrived: a lesson, a staged release, the placement check, or a saved/corrected sentence. */
  via?: 'lesson' | 'staged' | 'placement' | 'saved';
  /** core items: when the kanji spelling was taught (its read card was created). */
  spelledAt?: Date;
  /** kanji items: kept on the handwriting list beyond Settings.writeList. */
  pinned?: boolean;
  /** User-written memory hook (overrides content/mnemonics.json). */
  customMnemonic?: string;
  hideMnemonic?: boolean;
}

/**
 * Card types per item kind (src/srs/items.ts cardTypesFor):
 *   kana: read, write            kanaRule: read
 *   kanji: write (+ meaning when the kanji has no taught word)
 *   word: read (+ produce when WordEntry.use)
 *   core: listen (+ produce when use) (+ read once spelled with kanji)
 *   grammar: comprehend (+ build unless recognitionOnly)
 *   sentence: cloze
 */
export type CardType = 'read' | 'write' | 'meaning' | 'listen' | 'produce' | 'comprehend' | 'build' | 'cloze';

/** Retention breakdown families (change 13). */
export type CardFamily = 'write' | 'read' | 'listen' | 'produce' | 'grammar';

/** FSRS parameter presets: production = write, produce, build, cloze; receptive = read, meaning, listen, comprehend. */
export type FsrsPreset = 'production' | 'receptive';

/** 'retired': a write card past the write list (still kept, restored when the list grows or the kanji is pinned).
 *  There is no "suspend by hand" (rejected: retire-this-card modes). */
export type SuspendReason = 'retired';

export interface CardRecord extends FsrsCard {
  id: string;              // `${itemId}|${cardType}`
  itemId: string;
  kind: ItemKind;
  type: CardType;
  /** Suspended cards are never scheduled. */
  suspended?: SuspendReason;
}

/**
 * How the answer was given. choice = 'Show options' hint or hands-busy mode (graded at most Hard);
 * self = reveal + Missed/Got it; paper = written on paper and self-checked; partner = graded by the
 * partner (Session A quiz, Session C dictation, monthly quiz).
 */
export type AnswerMode = 'typed' | 'written' | 'spoken' | 'self' | 'choice' | 'partner' | 'paper';

/**
 * 'review': a warm-up (or make-up) answer. 're-ask': the graded retry after a warm-up miss.
 * 'first-check': a New card's first graded answer, and also its graded retry inside the first check.
 * 'partner': applied from a partner's verdict.
 */
export type ReviewContext = 'review' | 'first-check' | 're-ask' | 'partner';

export interface ReviewLogRecord {
  id?: number;             // auto-increment
  cardId: string;
  itemId: string;
  kind: ItemKind;
  type: CardType;
  grade: Grade;            // 1 Again, 2 Hard, 3 Good (objective cards never give 4 Easy)
  reviewedAt: Date;
  /** Time spent answering, ms (real value; the day total caps each answer at 2 min). */
  durationMs: number;
  mode: AnswerMode;
  /** FSRS state before this review (ts-fsrs State). */
  prevState: number;
  /** Whole days since the card's previous review (0 for a new card): real-retention buckets. */
  elapsedDays: number;
  context: ReviewContext;
  /** Word read cards: both sub-outcomes. */
  parts?: { reading: boolean; meaning: boolean };
  /** Writing cards: what the learner wrote with. */
  input?: 'finger' | 'stylus' | 'paper';
  /** The learner overrode the writing judgement ('I wrote it right'). */
  override?: true;
  /** Flagged surprise miss (last Good was fast, now Again). */
  surprise?: true;
}

/** Steps of a study day (src/components/study/session/machine.ts). */
export type SessionStepId = 'warmup' | 'teach' | 'memory' | 'read' | 'check' | 'output' | 'fluency' | 'summary';
/** The once-a-day steps that DayRecord.steps records. Warm-up, teach, memory and check are content-driven:
 *  planToday recomputes them from what is due, what is left to introduce and which New cards are unchecked. */
export type DailyStepId = 'read' | 'output' | 'fluency';

/** Where new-learning time goes. Only kanji, core and grammar enter the 60/20/20 shares. */
export type NewStream = 'sprint' | 'kanji' | 'staged' | 'core' | 'grammar';
/** Priced new-learning seconds by stream (lesson + first check). */
export type StreamSeconds = Record<NewStream, number>;

/** One row per study day, key 'YYYY-MM-DD'. */
export interface DayRecord {
  date: string;
  /** Solo study time, ms (graded answers capped at 2 min each, plus lessons, reading, output, make-up). */
  studyMs: number;
  /** Together sessions, ms. */
  togetherMs: number;
  /** Reviews done (graded answers of every context). */
  reviews: number;
  /** Of those, graded Hard or Good. */
  correct: number;
  /** Warm-up review time, ms: graded answers with context 'review' or 're-ask' outside a make-up session (capped at
   *  2 min each). First checks and partner grades are excluded. Feeds the minimum rule and the governor's day total. */
  reviewMs: number;
  /** Read, output and fluency time, ms (counted against the day's strand reserve). */
  strandMs: number;
  /** Items introduced through lessons and staged releases (only when the item was created). */
  newItems: number;
  /** Priced seconds of everything introduced today, by stream (sprint and staged included). */
  newSec: StreamSeconds;
  /** Counts toward the streak (change 8 minimum rule). */
  minimumDone: boolean;
  /** Every step of a full (any/desk) plan finished. Implies minimumDone. */
  goalMet: boolean;
  /** A missed day restored by a make-up session within 48 h (set on the missed day's row). */
  repaired?: boolean;
  /** Time spent in make-up sessions today, ms (§3.1.11). */
  makeupMs?: number;
  /** Travel/sick mode: neither counts nor breaks the streak. */
  travel?: boolean;
  /** The planner ran in catch-up mode today. Sticky for the rest of the day; tomorrow's hysteresis reads it. */
  catchUp?: boolean;
  /** Once-a-day steps finished today (set-add), so a later sitting skips them. */
  steps: DailyStepId[];
  /** Together sessions credited to this member on this date (set-add): creditTogetherSession is idempotent on it. */
  together?: TogetherSessionId[];
}

/** A rest token covering one day (2 per ISO week, no rollover). */
export interface RestTokenRecord {
  /** The covered day, 'YYYY-MM-DD'. */
  date: string;
  /** Monday of its ISO week. */
  week: string;
  /** When it was spent; before `date` means planned in advance. */
  usedAt: Date;
}

export type EncounterSource = 'sentence' | 'story' | 'output' | 'partner' | 'chat' | 'fluency';

/** One contextual encounter with an introduced item (target: ≥ 8 per word over 6 weeks). */
export interface EncounterRecord {
  id?: number;
  itemId: string;
  day: string;
  source: EncounterSource;
  at: Date;
}

/** A kanji's later word, waiting for its release day. */
export interface StagedWordRecord {
  /** 'word:1463770' or 'core:cw-0123'. */
  itemId: string;
  kanji: string;
  /** First study day on which it may be released. */
  releaseDay: string;
  slot: 2 | 3;
  releasedAt?: Date;
}

/** Story ladder: 1 read-while-listening done, 2 listen-only done, 3 timed re-read done. */
export interface StoryProgressRecord {
  storyId: string;
  stage: 0 | 1 | 2 | 3;
  firstDay?: string;
  /** Day the next ladder step is due: listen-only at firstDay + 3, timed re-read at firstDay + 10. */
  nextDay?: string;
  /** Gist answers, one per attempt (true = right). */
  gist: boolean[];
  /** Characters per minute of timed re-reads, oldest first. */
  cpm: number[];
  /** ISO week it was the couple's shared story. */
  sharedWeek?: string;
}

/** Replaces localStorage 'issho.srs.sentencesShown': 7-day rest after a sentence is shown. */
export interface SentenceShownRecord {
  id: string;              // SentenceEntry.id
  day: string;             // last shown
  count: number;
}

/** What the output step asked for. */
export interface OutputTarget {
  /** Item id of the target word or grammar point. */
  ref: string;
  /** Shown in the prompt ('もう', '〜たい'). */
  label: RubyText;
  en: string;
}

/** One output-step sentence ('today's sentence' to the partner). */
export interface OutputSentenceRecord {
  id: string;              // uuid
  day: string;
  target: OutputTarget;
  /** First attempt, before any edit. */
  draft: string;
  /** What was sent. */
  text: string;
  /** 'pending': queued until the AI is reachable; 'unavailable': AI disabled; 'skipped': just show me / no check. */
  check: 'pending' | 'done' | 'skipped' | 'unavailable';
  issues?: AiIssue[];
  corrected?: RubyText;
  rule?: string;
  /** Cloze card made from the verified correction (only when the card guard passed). */
  cardId?: string;
  /** Outbox clientId of the chat message. */
  chatClientId?: string;
  /** 'This tip seems wrong' was tapped. */
  reported?: boolean;
  /** A result that arrived after sending (queued check) has been shown to the learner. */
  resultSeen?: boolean;
  createdAt: Date;
}

/** A passed can-do (only passed checks award; attempts are counted). */
export interface CanDoRecord {
  id: string;              // 'u03-cd2'
  unit: number;
  attempts: number;
  passedAt?: Date;
  /** auto = read/listen questions; ai = AI rubric check (speak/write). Partners never judge each other's Japanese. */
  via?: 'auto' | 'ai';
}

/** Milestones already celebrated, so each shows once: 'chapter:7', 'season:2', 'M1', 'kana-check'. */
export interface MilestoneRecord {
  id: string;
  reachedAt: Date;
  seenAt?: Date;
}

/** The together week as this phone computed it (src/srs/together.ts buildWeekPlan). In a duo run the opener's
 *  choices travel in TogetherLiveState.plan and the joiner follows them. */
export interface TogetherWeekPlan {
  week: string;            // Monday
  /** One per slot, plus { id: 'monthly' } on the month's first Saturday when it falls in this week. */
  sessions: { id: TogetherSessionId; day: string; time: string; doneAt?: string; minutes?: number }[];
  /** The couple's settled unit: the highest unit whose grammar both partners introduced ≥ 2 days ago (0 = none). */
  settledUnit: number;
  /** Session A: core conversation and its stage (1–4). Stage is capped at 1 for a unit above settledUnit. */
  conversation?: { scriptId: string; stage: 1 | 2 | 3 | 4 };
  /** Session B: task card of a settled unit; `repeat` = the 2–7-day return with its twist. */
  task?: { unit: number; taskId: string; repeat: boolean };
  /** Session B without a task (no settled unit yet, or every task run): the first eligible free role-play, else the
   *  core conversation of unit settledUnit + 1; run at stage 1 and never stage-marked by Session B. */
  rolePlayId?: string;
  /** Shared weekly story (first story ready for both partners). */
  storyId?: string;
  /** The month's first Saturday is in this week: the separate monthly session is scheduled. */
  monthly: boolean;
  /** Monthly session: capstone skit for the most recent settled unit whose capstone isn't done. */
  capstoneUnit?: number;
  /** A season finale is due: Session C runs the can-do showcase instead of dictation. */
  showcase: boolean;
}

export interface TogetherPlanRecord {
  week: string;
  plan: TogetherWeekPlan;
  updatedAt: Date;
}

/** Together events waiting to be posted (POST /api/together/events), like the chat outbox. */
export interface TogetherOutboxRecord {
  clientId: string;
  createdAt: Date;
  week: string;
  /** JSON of shared/api.ts TogetherEvent. */
  event: string;
  attempts: number;
  failed?: string;
}

/** A partner quiz this phone took part in; idempotency for applying verdicts. */
export interface PartnerQuizRecord {
  quizId: string;
  /** answerer: the pool came from this phone's cards; asker: this phone showed the answers. */
  role: 'answerer' | 'asker';
  createdAt: Date;
  appliedAt?: Date;
  graded: number;
  practiced: number;
}

/** Pitch-ear drill: a simple Leitner box per word (not FSRS). */
export interface PitchBoxRecord {
  ref: string;             // 'core:cw-0042' | 'word:…'
  box: 0 | 1 | 2 | 3 | 4;
  nextDay: string;
  seen: number;
  correct: number;
}

export type FluencyKind = 'reread' | 'speed' | 'numbers' | 'pitch';

/** One fluency slot result. reread: value = chars/min; speed: cards read; numbers/pitch: correct. */
export interface FluencyLogRecord {
  id?: number;
  kind: FluencyKind;
  day: string;
  at: Date;
  value: number;
  /** Story id for rereads. */
  ref?: string;
}

export type DailyMinutes = 20 | 25 | 30 | 40;

/** If-then plan: 'After I pour my evening tea at the kitchen table, I open Issho'. */
export interface HabitCue {
  text: string;
  /** 'HH:MM' local: reminder time. */
  time: string;
}

export interface Settings {
  id: 'me';
  name: string;
  onboarded: boolean;
  /** Daily study budget (time governor). Default 25. */
  dailyMinutes: DailyMinutes;
  /** Kanji ranked above this keep a write card only until stable (stability > 21 d). 0–2136, default 500. */
  writeList: number;
  /** Desired retention of receptive cards: one of RECEPTIVE_RETENTIONS. Production cards use PRODUCTION_RETENTION. */
  receptiveRetention: number;
  /** FSRS weights per preset (never fitted on the device in v2; absent = ts-fsrs defaults). */
  fsrsWeights?: Partial<Record<FsrsPreset, number[]>>;
  furigana: 'always' | 'unknown' | 'never';
  audio: boolean;
  /** Model audio playback rate; absent = automatic (0.85 for course days 1–90, then 1). */
  audioRate?: number;
  /** Device voice (SpeechSynthesisVoice.voiceURI) for the last-resort fallback. */
  ttsVoice?: string;
  writingHand: 'finger' | 'stylus';
  /** Accessibility: typed answers offer choices (logged 'choice', graded at most Hard). */
  handsBusy: boolean;
  /** Output step: skip the find-it-yourself step and show the correction at once. */
  justShowMe: boolean;
  /** Placement check passed for the script (its kana start in Review). */
  knowsHiragana: boolean;
  knowsKatakana: boolean;
  cue?: HabitCue;
  /** 'If I miss it, I do 3 minutes before brushing my teeth.' */
  coping?: string;
  /** The couple's together slots (mirrors the server's latest 'slots' event). */
  togetherSlots: TogetherSlot[];
  sharedGoal?: SharedGoal;
  /** Day keys (course weeks 4 and 8) when Today prompts both to review their plans. */
  planReviewDays: string[];
  /** Travel/sick mode until this day, inclusive: streak frozen, no new items, reviews optional. */
  travelUntil?: string;
  /** Fresh start chosen after a 3+ day gap: next Monday or the 1st of the month. From that day Today shows a
   *  fresh-start header and the week view starts on that day, and the governor stays in catch-up until Rv ≤ LF
   *  (no new items before that). Cleared after the first normal-mode day on or after it. */
  freshStart?: string;
  /** Partner may see accuracy (correct counts). Default false: effort only. */
  shareAccuracy: boolean;
  // Home server (together features)
  serverUrl?: string;          // '' = same origin
  deviceToken?: string;
  memberId?: string;
  householdName?: string;
  /** Kept across unpairing: the chat cache and unsent messages belong to that household. */
  lastPairing?: LastPairing;
}

export interface LastPairing {
  householdId?: string;
  memberId: string;
  serverUrl: string;
}

/** Chat messages waiting to be sent while offline. */
export interface OutboxRecord {
  clientId: string;
  createdAt: Date;
  householdId?: string;
  kind: 'text' | 'voice';
  text: string;
  transcript?: string;
  audio?: Blob;
  audioId?: string;
  /** 'daily' = the output step's sentence of the day. */
  tag?: 'daily';
  attempts: number;
  failed?: string;
}

/** Local cache of chat messages (mirrors server). */
export interface ChatMessageRecord {
  id: number;
  clientId: string;
  memberId: string;
  createdAt: string;
  writtenAt?: string;
  kind: 'text' | 'voice' | 'system';
  text: string;
  transcript?: string;
  audioId?: string;
  tag?: 'daily';
}

/** A sentence kept for a cloze card: saved from reading, or a verified AI correction. */
export interface SavedSentenceRecord {
  id: string;              // SentenceEntry.id, or 'custom-<uuid>'
  jp: RubyText;
  en: string;
  savedAt: Date;
  source: 'reading' | 'story' | 'correction' | 'recap';
  /** The word the cloze card blanks (first occurrence of `surface` in rubyToPlain(jp)). */
  blank: { surface: string; reading: string; ref?: WordRef };
}
