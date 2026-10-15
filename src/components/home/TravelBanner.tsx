// Today while travel/sick mode is on: the streak is frozen, nothing new comes, reviews are optional.
import { useState } from 'react';
import { setTravel } from '../../srs/habits.ts';
import { Icon } from '../ui.tsx';
import { dayLabel } from './labels.ts';

export function TravelBanner({ until }: { until: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const end = async () => {
    setBusy(true);
    setProblem(false);
    try {
      await setTravel(null);
    } catch {
      setProblem(true);
      setBusy(false);
    }
  };
  return (
    <section className="card hm-prompt hm-travel" aria-labelledby="travel-title">
      <h2 id="travel-title" className="hm-prompt-title"><Icon name="travel" size={18} />Away until {dayLabel(until)}</h2>
      <p className="hm-hint">
        Your streak is paused, nothing new comes in, and reviews are optional. When you're back, Issho eases you in.
      </p>
      <div className="hm-prompt-actions">
        <button type="button" className="btn secondary small" onClick={() => void end()} disabled={busy} aria-busy={busy}>
          I'm back
        </button>
      </div>
      {problem && <p className="hm-error" role="alert">Couldn't save that on this phone. Try again.</p>}
    </section>
  );
}
