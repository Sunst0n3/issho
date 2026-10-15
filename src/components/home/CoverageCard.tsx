// Learn: how much of a typical text the learner can decode (Matsushita's kanji coverage table),
// plus the words they know.
import { coverageShare } from '../../srs/milestones.ts';
import { percent, plural } from './labels.ts';

/** The first row of the coverage table: the goal shown below it. */
const FIRST_GOAL = { kanji: 100, share: 0.74 };

export function CoverageCard({ kanjiCanRead, wordsKnown }: { kanjiCanRead: number; wordsKnown: number }) {
  const share = coverageShare(kanjiCanRead);
  return (
    <section className="card hm-stat-card" aria-labelledby="coverage-title">
      <h2 id="coverage-title" className="hm-section-title">Reading coverage</h2>
      {share === null ? (
        <>
          <p className="hm-stat-big">{plural(kanjiCanRead, 'kanji', 'kanji')} you can read</p>
          <p className="hm-hint">
            At {FIRST_GOAL.kanji} kanji: about {percent(FIRST_GOAL.share)} of the words in a typical text.
          </p>
        </>
      ) : (
        <>
          <p className="hm-stat-big">You can decode about {percent(share)} of the words in a typical text</p>
          <p className="hm-hint">From the {plural(kanjiCanRead, 'kanji', 'kanji')} you read reliably.</p>
        </>
      )}
      <p className="hm-stat-line"><strong>{wordsKnown.toLocaleString()}</strong> words known</p>
    </section>
  );
}
