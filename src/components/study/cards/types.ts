import type { Grade } from 'ts-fsrs';
import type { KanaExample, WordInfo } from '../../../lib/data.ts';
import type {
  AccentInfo,
  AnswerMode,
  CardRecord,
  GrammarBuildItem,
  GrammarExample,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  ReviewLogRecord,
  RubyText,
  SavedSentenceRecord,
  SentenceEntry,
} from '../../../lib/types.ts';

interface Base {
  card: CardRecord;
  /** Typed cards: the 4 choices behind "Show options" (and shown at once in hands-busy mode), the answer among them.
   *  Empty for self-graded and written cards. */
  options: string[];
  /** The answer a choice is checked against (one of `options`). */
  answer: string;
  /** The learner's own memory hook for the item: shown after a miss, never on the question. */
  customMnemonic?: string;
}

/**
 * A sentence split around the word being asked: the word itself is plain text (never ruby, never a reading), the
 * rest is ruby markup shown with the card's furigana rule.
 */
export interface SplitCue {
  before: RubyText;
  target: string;
  after: RubyText;
}

/**
 * Everything a review card needs, loaded, with its options chosen. `display` is the word as the learner knows it,
 * for the answer side: kana until a core word is spelled with kanji, then `{written|kana}`.
 */
export type PreparedCard =
  | (Base & { view: 'kana-read'; kana: KanaEntry; mode: 'romaji' | 'word'; word?: KanaExample })
  | (Base & {
      view: 'kana-write';
      kana: KanaEntry;
      /** sprint: sound only (auto-play + replay); after: example word with □ */
      prompt: 'sound' | 'word';
      word?: KanaExample;
      /** The example word with the kana as □ ('□さ'), for the 'word' prompt. */
      blanked?: string;
      /** The row named with a sound shared by two kana (を sounds like お: 'わ'). */
      row?: string;
    })
  | (Base & { view: 'kana-rule'; rule: KanaRule; word: { kana: string; en: string }; wordIndex: number })
  | (Base & {
      view: 'kanji-write';
      kanji: KanjiEntry;
      anchor?: WordInfo;
      /** anchor written with the kanji as □ */
      blanked?: string;
      reading: string;
    })
  | (Base & { view: 'kanji-meaning'; kanji: KanjiEntry })
  | (Base & { view: 'word-read'; word: WordInfo; carrier?: SentenceEntry; accent?: AccentInfo; cue: SplitCue; display: RubyText })
  | (Base & { view: 'produce'; word: WordInfo; accent?: AccentInfo; display: RubyText })
  | (Base & { view: 'listen'; word: WordInfo; accent?: AccentInfo; display: RubyText })
  | (Base & { view: 'grammar-comprehend'; point: GrammarPoint; example: GrammarExample; exampleIndex: number })
  | (Base & {
      view: 'grammar-build';
      point: GrammarPoint;
      item: GrammarBuildItem;
      itemIndex: number;
      tiles: boolean;
      shuffledTiles: string[];
    })
  | (Base & { view: 'cloze'; sentence: SavedSentenceRecord; cue: SplitCue });

export type CardView = PreparedCard['view'];

/** One answer to a card. The block grades it once and decides on feedback. */
export interface CardAnswer {
  grade: Grade;
  mode: AnswerMode;
  /** Word read cards: both halves of the answer. */
  parts?: ReviewLogRecord['parts'];
  /** Writing cards: what the learner wrote with. */
  input?: ReviewLogRecord['input'];
  /** 'I wrote it right' after the pad judged Again. */
  override?: boolean;
  /** The answer is already on screen (a self-graded card's reveal): Got it moves straight on. */
  revealed?: boolean;
}

export interface CardProps<V extends CardView> {
  prepared: Extract<PreparedCard, { view: V }>;
  onAnswer: (answer: CardAnswer) => void;
  /** Settings.handsBusy: typed cards show their choices at once (logged 'choice', at most Hard). */
  handsBusy?: boolean;
  /** "Write on paper" is offered (false in an anywhere sitting). */
  paperAllowed?: boolean;
}
