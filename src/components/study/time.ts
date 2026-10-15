// Visible study time. Time only runs while the page is visible, and it is added
// to today's DayRecord in chunks: when the page is hidden, when a study step
// ends and when the screen closes. Each chunk is booked as the kind of study it
// was: lessons and reviews ('lesson'), reading, output and fluency ('strand'),
// or a make-up session ('makeup').

import { useEffect, useState } from 'react';
import { countableMs } from '../../srs/days.ts';
import { addStudyTime } from '../../srs/progress.ts';
import { MAX_COUNTED_ANSWER_MS } from '../../srs/scheduler.ts';

const now = () => performance.now();
const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Chunks shorter than this wait for the next flush. */
const MIN_FLUSH_MS = 1000;

export type StudyTimeKind = 'lesson' | 'strand' | 'makeup';

export class StudyTimer {
  private startedAt: number | null;
  private total = 0;
  private flushedAt = 0;
  private credited = 0;
  private current: StudyTimeKind;

  constructor(visible = pageVisible(), kind: StudyTimeKind = 'lesson') {
    this.startedAt = visible ? now() : null;
    this.current = kind;
  }

  /** What the time running now is booked as. */
  get kind(): StudyTimeKind {
    return this.current;
  }

  /** Books the time so far as the current kind, then counts on as `kind`. */
  setKind(kind: StudyTimeKind): Promise<void> {
    if (kind === this.current) return Promise.resolve();
    const flushed = this.flush();
    this.current = kind;
    return flushed;
  }

  /** Visible milliseconds since the timer was created. */
  elapsed(): number {
    return this.total + (this.startedAt === null ? 0 : now() - this.startedAt);
  }

  pause(): void {
    if (this.startedAt === null) return;
    this.total += now() - this.startedAt;
    this.startedAt = null;
  }

  resume(): void {
    this.startedAt ??= now();
  }

  /**
   * Records that a graded answer already added its own time to the day
   * (gradeCard does), so the next flush leaves it out.
   */
  creditAnswer(durationMs: number): void {
    this.credited += Math.min(countableMs(durationMs), MAX_COUNTED_ANSWER_MS);
  }

  /** Adds the visible time since the last flush (minus credited answers) to today's study time, as the current kind. */
  flush(): Promise<void> {
    const at = this.elapsed();
    const ms = at - this.flushedAt - this.credited;
    if (ms < MIN_FLUSH_MS) return Promise.resolve();
    this.flushedAt = at;
    this.credited = 0;
    return addStudyTime(ms, this.current).catch((e: unknown) => console.warn('could not record study time', e));
  }
}

/**
 * A StudyTimer for the life of a screen: pauses while the page is hidden and
 * records what it has whenever the page hides or the screen unmounts.
 */
export function useStudyTimer(kind: StudyTimeKind = 'lesson'): StudyTimer {
  const [timer] = useState(() => new StudyTimer(pageVisible(), kind));
  useEffect(() => {
    timer.resume();
    const stop = () => {
      timer.pause();
      void timer.flush();
    };
    const onVisibility = () => (pageVisible() ? timer.resume() : stop());
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pageshow', onVisibility);
      stop();
    };
  }, [timer]);
  return timer;
}
