// The monthly session (the month's first weekend): a 20-item quiz each way, a shared goal with a
// fresh-start framing, and the capstone skit when one is due.

import { useState } from 'react';
import { dayKey, updateSettings } from '../../lib/db.ts';
import { postTogetherEvent, useTogetherState } from '../../sync/together.ts';
import { Capstone } from './Capstone.tsx';
import { dateFromKey } from './household.ts';
import { PartnerQuizStep } from './PartnerQuiz.tsx';
import { SkipStep, type SessionProps } from './SessionA.tsx';

/** The last day of the month `today` is in ('YYYY-MM-DD'). */
export function endOfMonth(today: string): string {
  const [y, m] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

export function MonthlySession(props: SessionProps) {
  const { run, plan, duo, me, partner, partnerProgress, online, aiOn, units, weekPlan } = props;
  switch (run.live.step) {
    case 'quiz':
      return (
        <>
          <header className="tg-step-head">
            <p className="label">Monthly quiz</p>
            <p className="muted">Up to 20 each way, the cards you each find hardest right now.</p>
          </header>
          <PartnerQuizStep kind="monthly" duo={duo} me={me} partner={partner}
            partnerRecentKanji={partnerProgress?.recentKanji ?? []} run={run} online={online} />
        </>
      );
    case 'goal':
      // The month the session's Saturday falls in (the week may start in the month before).
      return <GoalStep today={weekPlan.sessions.find((s) => s.id === 'monthly')?.day ?? dayKey()} onDone={run.next} />;
    case 'capstone': {
      const unit = units.find((u) => u.id === plan.capstoneUnit);
      if (!unit) return <SkipStep run={run} what="This capstone" />;
      return <Capstone unit={unit} duo={duo} me={me} partner={partner} aiOn={aiOn && online} onDone={run.next} />;
    }
    default:
      return null;
  }
}

function GoalStep({ today, onDone }: { today: string; onDone(): void }) {
  const { state } = useTogetherState();
  const month = dateFromKey(today).toLocaleDateString('en-US', { month: 'long' });
  const [text, setText] = useState(state?.goal?.text ?? '');
  const [targetDate, setTargetDate] = useState(endOfMonth(today));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const goal = { text: text.trim(), targetDate };
    if (!goal.text || saving) return;
    setSaving(true);
    try {
      await postTogetherEvent({ type: 'goal', goal });
      await updateSettings({ sharedGoal: goal });
    } finally {
      setSaving(false);
    }
    onDone();
  };

  return (
    <section className="card tg-goal">
      <p className="label">Goal</p>
      <h2>New month, fresh start: what's our goal for {month}?</h2>
      <p className="muted">Something you can both do by the date, like “order a whole dinner in Japanese”.</p>
      {state?.goal && <p className="muted tg-small">Last goal: {state.goal.text}</p>}
      <textarea className="tg-textarea" rows={2} maxLength={300} value={text} aria-label="Our goal"
        onChange={(e) => setText(e.target.value)} />
      <label className="tg-field">
        <span className="label">By</span>
        <input type="date" className="tg-time" value={targetDate} onChange={(e) => e.target.value && setTargetDate(e.target.value)} />
      </label>
      <button type="button" className="btn primary block" disabled={!text.trim() || saving} onClick={() => void save()}>
        Set our goal
      </button>
      <button type="button" className="btn ghost block" onClick={onDone}>Keep the goal we have</button>
    </section>
  );
}
