// Wording shared by the home screens: phases, dates, greetings, daily pace.
import type { CourseProgress, Phase } from '../../srs/course.ts';
import type { Curriculum } from '../../lib/types.ts';

export const PHASE_NAMES: Record<Phase, string> = {
  1: 'Kana & first words',
  2: 'Foundation',
  3: 'Reading for real',
  4: 'Real Japanese',
};

export type KanjiTargets = Record<2 | 3 | 4, number>;

export function phaseDetail(phase: Phase, targets: KanjiTargets): string {
  switch (phase) {
    case 1: return 'Hiragana, katakana and everyday words';
    case 2: return `Your first ${targets[2].toLocaleString()} kanji, inside real words`;
    case 3: return `Up to ${targets[3].toLocaleString()} kanji, reading real sentences`;
    case 4: return `All ${targets[4].toLocaleString()} everyday kanji`;
  }
}

/** Kanji introduced by the end of each phase: { 2: 300, 3: 800, 4: 2136 }. */
export function phaseKanjiTargets(curriculum: Curriculum): KanjiTargets {
  const kanjiBefore = (end: number) => curriculum.units.filter((u) => u.type === 'kanji' && u.index < end).length;
  const total = kanjiBefore(Infinity);
  return {
    2: kanjiBefore(curriculum.phaseEnds['2'] ?? Infinity),
    3: kanjiBefore(curriculum.phaseEnds['3'] ?? Infinity),
    4: total,
  };
}

/** "84 of 300 kanji" — progress toward the end of the current phase. */
export function phaseProgressText(p: CourseProgress, kanjiTotal: number): string {
  if (p.phase === 1) return `${p.phaseDone} of ${p.nextPhaseAt ?? 0} kana`;
  const target = p.nextPhaseAt ?? kanjiTotal;
  return `${p.kanjiIntroduced.toLocaleString()} of ${target.toLocaleString()} kanji`;
}

/** 0..1 toward the end of the current phase. */
export function phaseFraction(p: CourseProgress, kanjiTotal: number): number {
  const target = p.phase === 1 ? p.nextPhaseAt : p.nextPhaseAt ?? kanjiTotal;
  const done = p.phase === 1 ? p.phaseDone : p.kanjiIntroduced;
  return target ? Math.min(1, done / target) : 0;
}

export const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_JA = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

/** 'YYYY-MM-DD' → local Date at noon (safe from DST edges). */
export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function greeting(now: Date): string {
  const h = now.getHours();
  if (h >= 4 && h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Honest daily time for a pace of new items, once reviews have built up:
 * 3 → ~10 min, 5 → ~15, 8 → ~25 (rounded to 5).
 */
export function minutesForPace(newPerDay: number): number {
  return Math.max(5, Math.round((newPerDay * 3) / 5) * 5);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago" */
export function agoText(then: number, now: number = Date.now()): string {
  const min = Math.max(0, Math.round((now - then) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return plural(Math.round(h / 24), 'day') + ' ago';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
