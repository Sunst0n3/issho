// Contextual encounters: an introduced word met again in a sentence, story,
// output, partner game or fluency drill (target: ≥ 8 per word over 6 weeks).
// They steer which words reading targets next; they never touch FSRS.

import { dayKey, db } from '../lib/db.ts';
import type { EncounterRecord, EncounterSource } from '../lib/types.ts';
import { addDays } from './days.ts';

export const ENCOUNTER_TARGET = 8;
export const ENCOUNTER_WINDOW_DAYS = 42;

/** Logs one row per (item, day, source) for introduced items only; returns rows written. */
export function logEncounters(itemIds: readonly string[], source: EncounterSource, now: Date = new Date()): Promise<number> {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return Promise.resolve(0);
  const day = dayKey(now);
  return db.transaction('rw', db.items, db.encounters, async () => {
    const introduced = await db.items.bulkGet(ids);
    const rows: EncounterRecord[] = [];
    for (const [i, id] of ids.entries()) {
      if (!introduced[i]) continue;
      const sameDay = await db.encounters.where('[itemId+day]').equals([id, day]).toArray();
      if (!sameDay.some((e) => e.source === source)) rows.push({ itemId: id, day, source, at: now });
    }
    if (rows.length) await db.encounters.bulkAdd(rows);
    return rows.length;
  });
}

/** Encounters in the last 42 days per item (all items when itemIds is omitted). */
export async function encounterCounts(itemIds?: readonly string[], now: Date = new Date()): Promise<Map<string, number>> {
  const since = addDays(dayKey(now), -(ENCOUNTER_WINDOW_DAYS - 1));
  const rows = itemIds
    ? (await db.encounters.where('itemId').anyOf([...itemIds]).toArray()).filter((e) => e.day >= since)
    : await db.encounters.where('day').aboveOrEqual(since).toArray();
  const counts = new Map<string, number>();
  for (const id of itemIds ?? []) counts.set(id, 0);
  for (const row of rows) counts.set(row.itemId, (counts.get(row.itemId) ?? 0) + 1);
  return counts;
}
