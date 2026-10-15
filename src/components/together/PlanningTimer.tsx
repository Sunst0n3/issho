// Timers for the together sessions: silent planning before a task (90 s, skippable after 60 s)
// and the 4/3/2 retell rounds. The start time travels in the live state, so both phones count
// down together.

import { useEffect, useState } from 'react';

export const PLANNING_SECONDS = 90;
export const PLANNING_SKIP_AFTER = 60;

/** Seconds left of a timer that started at `startedAt` (ms epoch); the full length before it starts. */
export function secondsLeft(startedAt: number | undefined, seconds: number, now: number): number {
  if (!startedAt) return seconds;
  return Math.max(0, Math.ceil(seconds - (now - startedAt) / 1000));
}

/** The current time, re-read 4 times a second while a timer runs. */
export function useTicking(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

export function formatSeconds(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Countdown({ left, total, label }: { left: number; total: number; label: string }) {
  return (
    <div className="tg-countdown" role="timer" aria-label={`${label}: ${left} seconds left`}>
      <svg viewBox="0 0 36 36" aria-hidden="true" className="tg-countdown-ring">
        <circle cx="18" cy="18" r="16" className="tg-countdown-track" />
        <circle cx="18" cy="18" r="16" className="tg-countdown-fill"
          strokeDasharray={`${(left / total) * 100.5} 100.5`} transform="rotate(-90 18 18)" />
      </svg>
      <span className="tg-countdown-text">{formatSeconds(left)}</span>
    </div>
  );
}

/** Silent planning: each partner thinks through their half of the task without speaking. */
export function PlanningTimer({ startedAt, seconds = PLANNING_SECONDS, skipAfter = PLANNING_SKIP_AFTER, onStart, onDone }: {
  startedAt?: number;
  seconds?: number;
  skipAfter?: number;
  onStart(at: number): void;
  onDone(): void;
}) {
  const now = useTicking(Boolean(startedAt));
  const left = secondsLeft(startedAt, seconds, now);
  const elapsed = seconds - left;
  return (
    <section className="card tg-planning" aria-live="polite">
      <p className="label">Silent planning</p>
      <h2>Plan what you'll say, without talking</h2>
      <p className="muted">Think of the words you need for your half. Notes on paper are fine.</p>
      <Countdown left={left} total={seconds} label="Planning time" />
      {!startedAt ? (
        <button type="button" className="btn primary block" onClick={() => onStart(Date.now())}>Start planning</button>
      ) : left === 0 ? (
        <button type="button" className="btn primary block" onClick={onDone}>Start the task</button>
      ) : (
        <button type="button" className="btn secondary block" disabled={elapsed < skipAfter} onClick={onDone}>
          {elapsed < skipAfter ? `Skip in ${skipAfter - elapsed} s` : 'We are ready'}
        </button>
      )}
    </section>
  );
}
