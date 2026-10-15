import { ClozeCard } from './ClozeCard.tsx';
import { GrammarBuildCard } from './GrammarBuildCard.tsx';
import { GrammarComprehendCard } from './GrammarComprehendCard.tsx';
import { KanaReadCard } from './KanaReadCard.tsx';
import { KanaRuleCard } from './KanaRuleCard.tsx';
import { KanaWriteCard } from './KanaWriteCard.tsx';
import { KanjiMeaningCard } from './KanjiMeaningCard.tsx';
import { KanjiWriteCard } from './KanjiWriteCard.tsx';
import { ListenCard } from './ListenCard.tsx';
import { ProduceCard } from './ProduceCard.tsx';
import type { LeakMask } from '../../../srs/planner.ts';
import type { CardAnswer, PreparedCard } from './types.ts';
import { WordReadCard } from './WordReadCard.tsx';

/** The question for one prepared card, by view. */
export function ReviewCard({ prepared, onAnswer, handsBusy = false, paperAllowed = true, mask }: {
  prepared: PreparedCard;
  onAnswer: (answer: CardAnswer) => void;
  handsBusy?: boolean;
  paperAllowed?: boolean;
  /** What other cards due today still ask: the question keeps it back (§3.2.4 leak guard). */
  mask?: LeakMask;
}) {
  const props = { onAnswer, handsBusy, paperAllowed, ...(mask ? { mask } : {}) };
  switch (prepared.view) {
    case 'kana-read': return <KanaReadCard prepared={prepared} {...props} />;
    case 'kana-write': return <KanaWriteCard prepared={prepared} {...props} />;
    case 'kana-rule': return <KanaRuleCard prepared={prepared} {...props} />;
    case 'kanji-write': return <KanjiWriteCard prepared={prepared} {...props} />;
    case 'kanji-meaning': return <KanjiMeaningCard prepared={prepared} {...props} />;
    case 'word-read': return <WordReadCard prepared={prepared} {...props} />;
    case 'produce': return <ProduceCard prepared={prepared} {...props} />;
    case 'listen': return <ListenCard prepared={prepared} {...props} />;
    case 'grammar-comprehend': return <GrammarComprehendCard prepared={prepared} {...props} />;
    case 'grammar-build': return <GrammarBuildCard prepared={prepared} {...props} />;
    case 'cloze': return <ClozeCard prepared={prepared} {...props} />;
  }
}
