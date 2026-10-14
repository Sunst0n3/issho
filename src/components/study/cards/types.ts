import type { ReactNode } from 'react';
import type { Grade } from 'ts-fsrs';
import type {
  AnswerMode,
  CardRecord,
  GrammarDrill,
  GrammarPoint,
  KanaEntry,
  KanjiEntry,
  RadicalEntry,
  SurvivalWord,
  WordEntry,
} from '../../../lib/types.ts';
import type { SentenceLike } from '../sentences.ts';

/** One kanji of a word with its meaning, for "水 water + 曜 weekday + 日 day". */
export interface BreakdownPart {
  char: string;
  meaning?: string;
}

interface Base {
  card: CardRecord;
}

/** Everything a review card needs, loaded and with its options chosen. */
export type PreparedCard =
  | (Base & { view: 'kana-read'; kana: KanaEntry; options: string[] })
  | (Base & {
      view: 'kana-write';
      kana: KanaEntry;
      /** The row to name with the romaji when another kana sounds the same (ji: じ or ぢ). */
      row?: string;
    })
  | (Base & { view: 'radical-meaning'; radical: RadicalEntry; options: string[] })
  | (Base & { view: 'kanji-meaning'; kanji: KanjiEntry; options: string[]; notAccepted: string[] })
  | (Base & {
      view: 'kanji-reading';
      kanji: KanjiEntry;
      /** The taught word the kanji is shown in; absent when none is known yet. */
      word?: WordEntry;
      answer: string;
      options: string[];
      breakdown: BreakdownPart[];
    })
  | (Base & { view: 'kanji-write'; kanji: KanjiEntry; reading: string })
  | (Base & { view: 'word-reading'; word: WordEntry; options: string[]; breakdown: BreakdownPart[] })
  | (Base & { view: 'word-meaning'; word: WordEntry; options: string[]; breakdown: BreakdownPart[] })
  | (Base & { view: 'vocab-meaning'; vocab: SurvivalWord; options: string[] })
  | (Base & { view: 'vocab-recall'; vocab: SurvivalWord; options: string[] })
  | (Base & { view: 'grammar-drill'; point: GrammarPoint; drill: GrammarDrill; options: string[] })
  | (Base & { view: 'sentence-read'; sentence: SentenceLike });

export type CardView = PreparedCard['view'];

/** What the feedback panel shows once a card is answered. */
export interface FeedbackContent {
  /** Overrides the "Correct" / "Not quite" headline (writing uses its own). */
  title?: string;
  /** The expected answer, named in "Not quite: it's …". */
  expected: string;
  expectedLang?: 'ja';
  /** The other half of the answer: the meaning for a reading, the reading for a meaning. */
  note?: ReactNode;
  breakdown?: BreakdownPart[];
  /** Japanese (ruby markup allowed) read aloud by Listen. */
  speak?: string;
}

export interface CardAnswer {
  grade: Grade;
  mode: AnswerMode;
  correct: boolean;
  /** Absent for self-graded cards, which move straight on. */
  feedback?: FeedbackContent;
}

export interface CardProps<V extends CardView> {
  prepared: Extract<PreparedCard, { view: V }>;
  onAnswer: (answer: CardAnswer) => void;
  /** A practice repeat of a missed card: it is not graded again. */
  practice?: boolean;
}
