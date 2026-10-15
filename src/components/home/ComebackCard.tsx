// Today after a gap: an offer, never a replacement. A 3-minute welcome-back (no handwriting, nothing
// new), and after a longer gap a fresh start on the next Monday or the 1st. The plan panel below still
// shows the normal plan. Once today counts, the warm-up has done its job: only the fresh start (to
// choose, or the one chosen) is still shown. Warm copy only: the gap's length is never shown.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { chooseFreshStart, type ComebackOffer } from '../../srs/habits.ts';
import { Icon } from '../ui.tsx';
import { dayLabel } from './labels.ts';

export function ComebackCard({ offer, chosenFreshStart, warmUp = true, onDismiss }: {
  offer: ComebackOffer;
  /** Settings.freshStart: a fresh start already chosen (cleared after its first normal day). */
  chosenFreshStart?: string;
  /** Offer the 3-minute warm-up: false once today's minimum is done. */
  warmUp?: boolean;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  // The offer's date moves on each day; once one is chosen, that one stands and no other is offered.
  const freshDate = chosenFreshStart ?? (offer.kind === 'fresh-start' ? offer.freshStart : undefined);
  const chosen = chosenFreshStart !== undefined;

  const choose = async (date: string) => {
    setBusy(true);
    setProblem(false);
    try {
      await chooseFreshStart(date);
    } catch {
      setProblem(true);
    } finally {
      setBusy(false);
    }
  };

  if (!warmUp && !freshDate) return null;

  const actions = (
    <div className="hm-prompt-actions">
      {warmUp && (
        <Link to="/session?mode=welcome" className="btn primary small">
          Start the warm-up <Icon name="arrow" size={18} />
        </Link>
      )}
      <button type="button" className="btn ghost small" onClick={onDismiss}>Not now</button>
    </div>
  );
  const fresh = freshDate && (
    <div className="hm-fresh">
      {chosen ? (
        <p className="hm-ok" role="status">
          Fresh start on {dayLabel(freshDate)}: catch-up first, new items after.
        </p>
      ) : (
        <>
          <p className="hm-field-label">Fresh start on {dayLabel(freshDate)} — catch-up first, new items after</p>
          <button type="button" className="btn secondary small" onClick={() => void choose(freshDate)}
            disabled={busy} aria-busy={busy}>
            Start fresh on {dayLabel(freshDate)}
          </button>
        </>
      )}
      {problem && <p className="hm-error" role="alert">Couldn't save that on this phone. Try again.</p>}
    </div>
  );

  return (
    <section className="card hm-prompt hm-welcome" aria-labelledby="comeback-title">
      <h2 id="comeback-title" className="hm-prompt-title">
        <span lang="ja" aria-hidden="true" className="hm-prompt-mark">おかえり</span>
        {warmUp ? 'Welcome back — a 3-minute warm-up?' : 'Welcome back'}
      </h2>
      {warmUp ? (
        <>
          <p className="hm-hint">Just a few reviews, nothing new and no handwriting. Your full plan is still below.</p>
          {actions}
          {fresh}
        </>
      ) : (
        <>
          {fresh}
          {actions}
        </>
      )}
    </section>
  );
}
