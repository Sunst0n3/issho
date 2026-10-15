// Learn: the plan's milestones M0–M4 as targets, with where the learner is now.
import { PLAN_MILESTONES } from '../../srs/milestones.ts';
import type { LearnedCounts } from '../../srs/progress.ts';
import { Icon } from '../ui.tsx';

type Counts = Pick<LearnedCounts, 'kanjiIntroduced' | 'wordsIntroduced' | 'grammarIntroduced'> & {
  /** Basic kana introduced (placement included), of `kanaTotal`. */
  kanaIntroduced: number;
  kanaTotal: number;
};
type Milestone = (typeof PLAN_MILESTONES)[number];

/** The kana milestone (M0): no kanji yet, every basic kana instead. */
const isKanaMilestone = (m: Milestone) => m.kanji[1] === 0;

const range = ([lo, hi]: readonly [number, number]) => (lo === hi ? lo.toLocaleString() : `${lo.toLocaleString()}–${hi.toLocaleString()}`);

/** pure: every target of the milestone is met (the low end of a range counts; M0 needs all the kana). */
export function milestoneReached(m: Milestone, c: Counts): boolean {
  if (isKanaMilestone(m) && c.kanaIntroduced < c.kanaTotal) return false;
  return c.kanjiIntroduced >= m.kanji[0] && c.wordsIntroduced >= m.words && c.grammarIntroduced >= m.grammar[0];
}

function targetText(m: Milestone, kanaTotal: number): string {
  const kanji = isKanaMilestone(m) ? `all ${kanaTotal} kana` : `${range(m.kanji)} kanji`;
  return `${kanji}, ${m.words.toLocaleString()} words, ${range(m.grammar)} grammar points`;
}

export function MilestonesCard({ counts }: { counts: Counts }) {
  const next = PLAN_MILESTONES.find((m) => !milestoneReached(m, counts));
  return (
    <section className="card hm-stat-card" aria-labelledby="milestones-title">
      <h2 id="milestones-title" className="hm-section-title">Milestones</h2>
      <p className="hm-hint">
        Targets at 25 minutes a day. You: {counts.kanjiIntroduced.toLocaleString()} kanji,{' '}
        {counts.wordsIntroduced.toLocaleString()} words, {counts.grammarIntroduced.toLocaleString()} grammar points.
      </p>
      <ol className="hm-milestones">
        {PLAN_MILESTONES.map((m) => {
          const reached = milestoneReached(m, counts);
          const state = reached ? 'reached' : m === next ? 'next' : 'later';
          return (
            <li key={m.id} className={`hm-milestone ${state}`} aria-current={state === 'next' ? 'step' : undefined}>
              <span className="hm-milestone-id" aria-hidden="true">
                {reached ? <Icon name="check" size={14} strokeWidth={3} /> : m.id}
              </span>
              <span className="hm-milestone-text">
                <span className="hm-milestone-title">
                  {m.id} · around day {m.day.toLocaleString()}
                  {reached && <span className="visually-hidden"> (reached)</span>}
                </span>
                <span className="hm-hint">{targetText(m, counts.kanaTotal)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
