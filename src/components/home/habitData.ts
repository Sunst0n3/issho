// The habit picture behind Today's prompts (B's streak and comeback offer), and the prompts the
// learner put away for the day.
import { dayKey } from '../../lib/db.ts';
import { comeback, streak, type ComebackOffer, type StreakV2 } from '../../srs/habits.ts';

export interface HabitSnapshot {
  today: string;
  streak: StreakV2;
  comeback: ComebackOffer;
}

export async function loadHabitSnapshot(now: Date = new Date()): Promise<HabitSnapshot> {
  const [info, offer] = await Promise.all([streak(now), comeback(now)]);
  return { today: dayKey(now), streak: info, comeback: offer };
}

// ---- Dismissed prompts (per phone, per day; losing them only shows a prompt again) ----

const DISMISS_KEY = 'issho.today.dismissed';

function readDismissed(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** True when the prompt was put away earlier on this study day. */
export function isDismissed(prompt: string, today: string): boolean {
  return readDismissed()[prompt] === today;
}

export function dismiss(prompt: string, today: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ ...readDismissed(), [prompt]: today }));
  } catch {
    // Storage blocked: the prompt just comes back next time.
  }
}
