// Loads what the study screens need to display Japanese for this learner (course day, sprint rules, taught kana)
// and provides it to everything below. Until it has loaded, the plain defaults apply (no romaji).

import { useEffect, useState, type ReactNode } from 'react';
import { loadCourseSnapshot, taughtKana } from '../../srs/course.ts';
import { NO_SPRINT, StudyDisplayContext, type StudyDisplay } from './display.ts';

export async function loadStudyDisplay(now: Date = new Date()): Promise<StudyDisplay> {
  const [snapshot, taught] = await Promise.all([loadCourseSnapshot(now), taughtKana(now)]);
  return { courseDay: snapshot.courseDay, inSprint: snapshot.inSprint, taught, kana: snapshot.kana };
}

export function StudyDisplayProvider({ value, children }: {
  /** Already loaded (the session loads it with the plan); otherwise it is loaded here. */
  value?: StudyDisplay;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<StudyDisplay | null>(null);
  useEffect(() => {
    if (value) return;
    let live = true;
    loadStudyDisplay().then((d) => live && setLoaded(d), (e: unknown) => console.warn('could not load the display rules', e));
    return () => {
      live = false;
    };
  }, [value]);
  return <StudyDisplayContext.Provider value={value ?? loaded ?? NO_SPRINT}>{children}</StudyDisplayContext.Provider>;
}
