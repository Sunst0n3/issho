// What the study screens need to know to display Japanese for this learner right now: whether the kana sprint's
// display rules apply (romaji typing on kana cards, the romaji helper over untaught kana) and which kana are taught.
// The session provides it; screens outside a session get the plain defaults (no romaji anywhere).

import { createContext, useContext } from 'react';
import type { KanaEntry } from '../../lib/types.ts';

export interface StudyDisplay {
  courseDay: number;
  /** CourseSnapshot.inSprint. */
  inSprint: boolean;
  /** taughtKana(): basic kana introduced, plus voiced and yōon kana whose rule is introduced. */
  taught: ReadonlySet<string>;
  /** The kana table, for the romaji helper. */
  kana: readonly KanaEntry[];
}

export const NO_SPRINT: StudyDisplay = { courseDay: 0, inSprint: false, taught: new Set(), kana: [] };

export const StudyDisplayContext = createContext<StudyDisplay>(NO_SPRINT);

export function useStudyDisplay(): StudyDisplay {
  return useContext(StudyDisplayContext);
}
