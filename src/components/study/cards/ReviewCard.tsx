import { GrammarDrillCard } from './GrammarDrillCard.tsx';
import { KanaReadCard } from './KanaReadCard.tsx';
import { KanaWriteCard } from './KanaWriteCard.tsx';
import { KanjiMeaningCard } from './KanjiMeaningCard.tsx';
import { KanjiReadingCard } from './KanjiReadingCard.tsx';
import { KanjiWriteCard } from './KanjiWriteCard.tsx';
import { RadicalMeaningCard } from './RadicalMeaningCard.tsx';
import { SentenceReadCard } from './SentenceReadCard.tsx';
import type { CardAnswer, PreparedCard } from './types.ts';
import { VocabMeaningCard } from './VocabMeaningCard.tsx';
import { VocabRecallCard } from './VocabRecallCard.tsx';
import { WordMeaningCard } from './WordMeaningCard.tsx';
import { WordReadingCard } from './WordReadingCard.tsx';

/** The question for one prepared card, by card type and item kind. */
export function ReviewCard({ prepared, onAnswer, practice }: {
  prepared: PreparedCard;
  onAnswer: (answer: CardAnswer) => void;
  practice?: boolean;
}) {
  const props = { onAnswer, practice };
  switch (prepared.view) {
    case 'kana-read': return <KanaReadCard prepared={prepared} {...props} />;
    case 'kana-write': return <KanaWriteCard prepared={prepared} {...props} />;
    case 'radical-meaning': return <RadicalMeaningCard prepared={prepared} {...props} />;
    case 'kanji-meaning': return <KanjiMeaningCard prepared={prepared} {...props} />;
    case 'kanji-reading': return <KanjiReadingCard prepared={prepared} {...props} />;
    case 'kanji-write': return <KanjiWriteCard prepared={prepared} {...props} />;
    case 'word-reading': return <WordReadingCard prepared={prepared} {...props} />;
    case 'word-meaning': return <WordMeaningCard prepared={prepared} {...props} />;
    case 'vocab-meaning': return <VocabMeaningCard prepared={prepared} {...props} />;
    case 'vocab-recall': return <VocabRecallCard prepared={prepared} {...props} />;
    case 'grammar-drill': return <GrammarDrillCard prepared={prepared} {...props} />;
    case 'sentence-read': return <SentenceReadCard prepared={prepared} {...props} />;
  }
}
