// The together plan as it stands now. While paired, the household's latest slots and goal on the home
// server win over this phone's Settings: the partner may have changed them (in Settings or in a check-in
// or monthly session). A change this phone queued but hasn't sent yet wins over both, so an offline save
// isn't shown as undone.
import { useLiveQuery } from 'dexie-react-hooks';
import type { TogetherEvent, TogetherState } from '../../../shared/api.ts';
import { db } from '../../lib/db.ts';
import type { Settings, SharedGoal, TogetherSlot } from '../../lib/types.ts';
import { isPairedSettings } from '../../sync/client.ts';
import { useTogetherState } from '../../sync/together.ts';

/** This phone has a 'slots' / 'goal' event waiting in the together outbox. */
export interface PendingPlan { slots: boolean; goal: boolean }

export interface CurrentPlan { slots: TogetherSlot[]; goal?: SharedGoal }

const NOTHING_PENDING: PendingPlan = { slots: false, goal: false };

/** pure: `household` is null when unpaired or not loaded yet. */
export function currentPlan(
  settings: Pick<Settings, 'togetherSlots' | 'sharedGoal'>,
  household: Pick<TogetherState, 'slots' | 'goal'> | null,
  pending: PendingPlan = NOTHING_PENDING,
): CurrentPlan {
  return {
    slots: household?.slots.length && !pending.slots ? household.slots : settings.togetherSlots,
    goal: household?.goal && !pending.goal ? household.goal : settings.sharedGoal,
  };
}

function eventType(json: string): TogetherEvent['type'] | undefined {
  try {
    return (JSON.parse(json) as TogetherEvent).type;
  } catch {
    return undefined;
  }
}

async function pendingPlan(): Promise<PendingPlan> {
  const waiting = await db.togetherOutbox.filter((r) => !r.failed).toArray();
  const types = new Set(waiting.map((r) => eventType(r.event)));
  return { slots: types.has('slots'), goal: types.has('goal') };
}

/** The plan to show and to put in the calendar: see currentPlan. */
export function useCurrentPlan(settings: Settings): CurrentPlan {
  const { state } = useTogetherState();
  const pending = useLiveQuery(pendingPlan, [], NOTHING_PENDING);
  return currentPlan(settings, isPairedSettings(settings) ? state : null, pending);
}
