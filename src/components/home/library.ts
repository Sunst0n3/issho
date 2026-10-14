// Data for the kanji library and kanji pages: curriculum units with their
// meanings and the learner's state for each.
import { State } from 'ts-fsrs';
import { loadCurriculum, loadKanji, loadRadicals } from '../../lib/data.ts';
import { db, itemId } from '../../lib/db.ts';
import type { CardRecord, Curriculum, CurriculumUnit, KanjiEntry, RadicalEntry } from '../../lib/types.ts';

/** How many upcoming units are marked "next up". */
export const NEXT_UP = 5;

export type UnitState = 'learned' | 'next' | 'locked';

export interface UnitView {
  unit: CurriculumUnit;
  meaning: string;
  state: UnitState;
  /** A reviewed card of this unit keeps slipping (see needsWork). */
  struggling: boolean;
}

/**
 * A card that needs work: forgotten twice or more, or weak (stability under 3
 * days) after being forgotten. Cards that were never forgotten are left out:
 * every newly learned card starts with low stability, and those are on track.
 */
export function needsWork(card: CardRecord): boolean {
  if (card.suspended || card.reps === 0) return false;
  return card.lapses >= 2 || (card.lapses > 0 && card.stability < 3) || card.state === State.Relearning;
}

export function unitMeaning(unit: CurriculumUnit, kanji: Record<string, KanjiEntry>, radicals: ReadonlyMap<string, RadicalEntry>): string {
  return unit.type === 'kanji' ? kanji[unit.char]?.meanings[0] ?? '' : radicals.get(unit.char)?.meaning ?? '';
}

export function unitViews(
  curriculum: Curriculum,
  kanji: Record<string, KanjiEntry>,
  radicals: ReadonlyMap<string, RadicalEntry>,
  introduced: ReadonlySet<string>,
  struggling: ReadonlySet<string>,
): UnitView[] {
  let nextLeft = NEXT_UP;
  return [...curriculum.units].sort((a, b) => a.index - b.index).map((unit) => {
    const id = itemId(unit.type, unit.char);
    let state: UnitState = 'locked';
    if (introduced.has(id)) state = 'learned';
    else if (nextLeft > 0) {
      state = 'next';
      nextLeft--;
    }
    return { unit, meaning: unitMeaning(unit, kanji, radicals), state, struggling: struggling.has(id) };
  });
}

/** Everything the library shows, read live from the database. */
export async function loadLibrary(): Promise<UnitView[]> {
  const [curriculum, kanji, radicalList] = await Promise.all([loadCurriculum(), loadKanji(), loadRadicals()]);
  const [ids, cards] = await Promise.all([
    db.items.where('kind').anyOf('kanji', 'radical').primaryKeys(),
    db.cards.where('kind').anyOf('kanji', 'radical').toArray(),
  ]);
  const radicals = new Map(radicalList.map((r) => [r.char, r]));
  const struggling = new Set(cards.filter(needsWork).map((c) => c.itemId));
  return unitViews(curriculum, kanji, radicals, new Set(ids.map(String)), struggling);
}
