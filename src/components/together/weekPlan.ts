// This week's together plan as this phone sees it (B's loadWeekPlan over the cached together
// state and the partner's progress), and what a session's status is today.

import { useEffect, useState } from 'react';
import type { TogetherSessionId, TogetherState } from '../../../shared/api.ts';
import { dayKey } from '../../lib/db.ts';
import type { TogetherWeekPlan } from '../../lib/types.ts';
import { addDays } from '../../srs/days.ts';
import { loadWeekPlan } from '../../srs/together.ts';
import { useHousehold } from '../../sync/stats.ts';
import { useTogetherState } from '../../sync/together.ts';
import { splitHousehold } from './household.ts';

export type SessionStatus = 'done' | 'today' | 'overdue' | 'planned';
export type PlannedSession = TogetherWeekPlan['sessions'][number];

/** A session's status on `today`. The monthly session runs over its weekend (Saturday and Sunday). */
export function sessionStatus(s: PlannedSession, today: string): SessionStatus {
  if (s.doneAt) return 'done';
  if (s.day === today || (s.id === 'monthly' && addDays(s.day, 1) === today)) return 'today';
  return s.day < today ? 'overdue' : 'planned';
}

/** The session to offer today: one scheduled today, else the earliest still open from earlier this week. */
export function sessionToOffer(plan: TogetherWeekPlan | undefined, today: string): (PlannedSession & { status: SessionStatus }) | undefined {
  if (!plan) return undefined;
  const open = plan.sessions
    .map((s) => ({ ...s, status: sessionStatus(s, today) }))
    .filter((s) => s.status === 'today' || s.status === 'overdue');
  return open.find((s) => s.status === 'today') ?? open.sort((a, b) => a.day.localeCompare(b.day))[0];
}

/** Letters A, B, C with a session-done in `week`, from the together state. */
export function lettersDone(state: TogetherState | null, week: string): Set<TogetherSessionId> {
  return new Set((state?.sessions ?? []).filter((s) => s.week === week).map((s) => s.session));
}

export function useWeekPlan(): { plan?: TogetherWeekPlan; failed: boolean; state: TogetherState | null; offline: boolean } {
  const { state, offline } = useTogetherState();
  const { data } = useHousehold();
  const partner = splitHousehold(data).partner?.progress ?? undefined;
  const [result, setResult] = useState<{ plan?: TogetherWeekPlan; failed: boolean }>({ failed: false });
  const key = JSON.stringify([state, partner, dayKey()]);
  useEffect(() => {
    let alive = true;
    loadWeekPlan({ state, partner }).then(
      (plan) => { if (alive) setResult({ plan, failed: false }); },
      () => { if (alive) setResult((r) => ({ plan: r.plan, failed: true })); },
    );
    return () => { alive = false; };
  }, [key]);
  return { ...result, state, offline };
}
