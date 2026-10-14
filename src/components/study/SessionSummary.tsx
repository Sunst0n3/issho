import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { StreakInfo } from '../../srs/progress.ts';
import { Glyph } from '../Glyph.tsx';
import { streakText } from '../home/labels.ts';
import { Icon } from '../ui.tsx';
import type { LearnedLabel } from './learn/data.ts';

export interface SessionStats {
  /** Visible study time, ms. */
  ms: number;
  reviews: number;
  correct: number;
  learned: LearnedLabel[];
}

/** One character per tile; longer things (vocab, grammar) in the body face. */
function LearnedTile({ item }: { item: LearnedLabel }) {
  const single = [...item.text].length === 1;
  return (
    <li className="st-learned">
      {single ? <Glyph char={item.text} size={30} /> : <span lang={item.lang} className="st-learned-text">{item.text}</span>}
      {item.meaning && <span className="st-learned-meaning">{item.meaning}</span>}
    </li>
  );
}

export function SessionSummary({ stats, streak, newBlocked, onDone }: {
  stats: SessionStats;
  streak?: StreakInfo;
  newBlocked?: string;
  onDone: () => void;
}) {
  // The last answer's button is gone: start screen readers and keyboards at the title.
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus({ preventScroll: true }), []);
  const minutes = Math.max(stats.ms > 0 ? 1 : 0, Math.round(stats.ms / 60_000));
  const accuracy = stats.reviews ? `${Math.round((stats.correct / stats.reviews) * 100)}%` : '–';
  return (
    <section className="st-summary" aria-labelledby="st-summary-title">
      <p className="st-eyebrow" lang="ja">おつかれさま</p>
      <h1 id="st-summary-title" className="st-summary-title" ref={title} tabIndex={-1}>Session complete</h1>

      {streak && streak.current > 0 && (
        <div className="card st-streak">
          <span className="st-streak-badge"><Icon name="flame" size={22} filled /></span>
          <span><strong>{streakText(streak.current)}</strong>{streak.best > streak.current && <span className="muted"> · best {streak.best}</span>}</span>
        </div>
      )}

      <dl className="st-stats">
        <div><dt>Minutes</dt><dd>{minutes}</dd></div>
        <div><dt>Reviews</dt><dd>{stats.reviews}</dd></div>
        <div><dt>Correct</dt><dd>{accuracy}</dd></div>
      </dl>

      {stats.learned.length > 0 && (
        <section className="st-section">
          <h2 className="label">Learned today</h2>
          <ul className="st-learned-row">
            {stats.learned.map((item) => <LearnedTile key={item.itemId} item={item} />)}
          </ul>
        </section>
      )}

      {newBlocked && <p className="card st-note">{newBlocked}</p>}

      <div className="st-footer">
        <button type="button" className="btn primary st-grow" onClick={onDone}>Done</button>
      </div>
    </section>
  );
}

/**
 * Nothing to review and nothing new: point to the practice that is always open.
 * `limitReached` when cards are due but today's review limit is used up.
 */
export function SessionEmpty({ limitReached = false, newBlocked }: { limitReached?: boolean; newBlocked?: string }) {
  return (
    <section className="st-summary st-empty" aria-labelledby="st-empty-title">
      <p className="st-eyebrow" lang="ja">よくできました</p>
      <h1 id="st-empty-title" className="st-summary-title">{limitReached ? "Today's reviews are done" : "You're all caught up"}</h1>
      <p className="muted">
        {limitReached
          ? "You've reached today's review limit. The rest wait for tomorrow, so nothing gets rushed. Until then:"
          : "Nothing is due right now and today's new items are done. New reviews arrive as cards come due. Until then:"}
      </p>
      {newBlocked && <p className="card st-note">{newBlocked}</p>}
      <div className="st-links">
        <Link className="card st-link" to="/write">
          <Icon name="pen" size={22} />
          <span><strong>Practice writing</strong><span className="muted">Kana and kanji you have learned</span></span>
          <Icon name="forward" size={18} />
        </Link>
        <Link className="card st-link" to="/read">
          <Icon name="book" size={22} />
          <span><strong>Read and shadow</strong><span className="muted">A few sentences at your level</span></span>
          <Icon name="forward" size={18} />
        </Link>
      </div>
      <div className="st-footer">
        <Link className="btn ink st-grow" to="/">Back to today</Link>
      </div>
    </section>
  );
}
