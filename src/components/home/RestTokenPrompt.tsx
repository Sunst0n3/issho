// Today, the morning after a day without study: "Use a rest token for yesterday?" A deliberate tap,
// never automatic. A used token keeps the streak alive (it adds nothing to it).
import { useState } from 'react';
import { spendRestToken } from '../../srs/habits.ts';
import { Icon } from '../ui.tsx';
import { mondayOf } from './labels.ts';

const RESULT_TEXT = {
  'none-left': "That week's two rest tokens are already used.",
  'not-allowed': "A rest token can't cover that day.",
} as const;

export function RestTokenPrompt({ date, today, tokensLeftThisWeek, onDismiss }: {
  /** The day to cover (StreakV2.offerTokenFor). */
  date: string;
  today: string;
  tokensLeftThisWeek: number;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  // On a Monday, yesterday belongs to last week: this week's count says nothing about it.
  const sameWeek = mondayOf(date) === mondayOf(today);

  const use = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await spendRestToken(date);
      // 'ok' and 'already' both leave the day covered: the prompt goes away with the live streak.
      if (result === 'none-left' || result === 'not-allowed') setProblem(RESULT_TEXT[result]);
    } catch {
      setProblem("Couldn't save that on this phone. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card hm-prompt" aria-labelledby="rest-token-title">
      <h2 id="rest-token-title" className="hm-prompt-title">
        <Icon name="rest" size={18} />Use a rest token for yesterday?
        {sameWeek && <span className="hm-prompt-count"> ({tokensLeftThisWeek} left this week)</span>}
      </h2>
      <p className="hm-hint">A rest day keeps your streak going. You have two a week.</p>
      <div className="hm-prompt-actions">
        <button type="button" className="btn secondary small" onClick={() => void use()} disabled={busy} aria-busy={busy}>
          Use a rest token
        </button>
        <button type="button" className="btn ghost small" onClick={onDismiss} disabled={busy}>Not now</button>
      </div>
      {problem && <p className="hm-error" role="alert">{problem}</p>}
    </section>
  );
}
