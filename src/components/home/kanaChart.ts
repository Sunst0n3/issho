// Kana chart layout.
import type { KanaEntry } from '../../lib/types.ts';

export type ChartRow = (KanaEntry | null)[];

/**
 * Lays kana out as the familiar chart: one row per group, each in the column of
 * the vowel its romaji ends with, leaving gaps (yi, ye, wu…). ん sits alone.
 */
export function chartRows(entries: readonly KanaEntry[], columns: string): ChartRow[] {
  const groups = new Map<string, KanaEntry[]>();
  for (const e of [...entries].sort((a, b) => a.order - b.order)) {
    const list = groups.get(e.group) ?? [];
    list.push(e);
    groups.set(e.group, list);
  }
  return [...groups.values()].map((list) => {
    const row: ChartRow = Array.from({ length: columns.length }, () => null);
    for (const e of list) {
      let col = e.romaji === 'n' ? 0 : columns.indexOf(e.romaji.slice(-1));
      if (col < 0 || row[col]) col = row.findIndex((c) => c === null);
      if (col >= 0) row[col] = e;
    }
    return row;
  });
}
