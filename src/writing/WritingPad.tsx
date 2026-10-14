// The handwriting canvas. The learner writes with a finger, pen or mouse;
// each finished stroke is checked against the next expected KanjiVG stroke.
// A correct stroke snaps to the clean model stroke in ink; a wrong one flashes
// shu and disappears. Buttons (undo, hint, clear, give up) live in the screen
// and drive the pad through its imperative handle.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { mistakeMessage } from './describe.ts';
import { estimateFrame, matchStrokeOf, type AcceptedStroke, type StrokeAttempt } from './matcher.ts';
import { BOX, distance, inkWidth, pathLength, pathStart, polylineLength, smoothPath, startDirection, type Point } from './path.ts';
import './writing.css';

export type WritingMode = 'trace' | 'guided' | 'memory';

export interface WritingResult {
  /** Wrong strokes drawn, in total. */
  mistakes: number;
  /** Strokes shown as a hint (hint button or automatically after repeated misses). */
  hintsUsed: number;
  strokeCount: number;
  gaveUp: boolean;
  /** Strokes that were not right first time (including any revealed by giving up). */
  failedStrokes: number;
}

export interface WritingPadHandle {
  /** Removes the last accepted stroke. */
  undo(): void;
  /**
   * Removes every stroke. Mid-attempt the mistake and hint counts are kept;
   * after the character is finished (or given up) it starts a fresh attempt.
   */
  clear(): void;
  /** Animates the next expected stroke (counted once per stroke). */
  hint(): void;
  /** Reveals the remaining strokes and finishes the attempt. */
  giveUp(): void;
}

export interface WritingPadProps {
  /** KanjiVG stroke paths in stroke order. */
  strokes: readonly string[];
  /** Changing the mode (or the strokes) starts a new attempt, so trace → guided → memory can reuse one pad. */
  mode: WritingMode;
  /** Called after every checked stroke; `detail` says why a stroke was rejected. */
  onStrokeResult?: (index: number, ok: boolean, detail: StrokeAttempt) => void;
  /** Called once, after the last stroke or on give-up. */
  onComplete?: (result: WritingResult) => void;
  /** What is being written, for the accessible name ("水", "the kanji for water"). */
  label?: string;
  /** Show the next stroke's start dot and direction arrow. Defaults to on, except in memory mode. */
  showStart?: boolean;
  /** Matcher tolerance multiplier (see MatchOptions.leniency). */
  leniency?: number;
  disabled?: boolean;
  className?: string;
}

/** A second miss on the same stroke shows it automatically. */
export const AUTO_HINT_AFTER = 2;
/**
 * Strokes shorter than this (box units) are taps: accepted when they are the
 * expected dot, otherwise ignored as stray touches and not counted as mistakes.
 */
const TAP_LENGTH = 1.5;
/** Touches this soon (ms) after a pen was down or hovering are a resting palm and are ignored. */
const PALM_REJECT_MS = 2000;
/** Pointer samples closer than this to the previous one add nothing. */
const MIN_SAMPLE_GAP = 0.25;
const FLASH_MS = 480;
/** Model units drawn per second by the hint and reveal animations. */
const DRAW_SPEED = 110;
const MIN_DRAW_MS = 320;

type Status = 'writing' | 'done' | 'gaveUp';

interface Attempt {
  /** What the learner drew for each accepted stroke (drives the frame). */
  accepted: Point[][];
  /** Misses on the current stroke. */
  tries: number;
  mistakes: number;
  failed: Set<number>;
  hinted: Set<number>;
  /** Non-zero while the current stroke's hint is shown; bumping it replays the animation. */
  hintRun: number;
  flash?: { id: number; d: string };
  status: Status;
  announcement: { id: number; text: string };
}

function freshAttempt(): Attempt {
  return {
    accepted: [],
    tries: 0,
    mistakes: 0,
    failed: new Set(),
    hinted: new Set(),
    hintRun: 0,
    status: 'writing',
    announcement: { id: 0, text: '' },
  };
}

const drawMs = (len: number) => Math.max(MIN_DRAW_MS, (len / DRAW_SPEED) * 1000);

/** Inline custom properties for the dash-offset draw animation. */
function drawStyle(d: string, delayMs = 0): CSSProperties {
  // Slightly longer than the measured length so no sliver is left undrawn.
  const len = pathLength(d) + 2;
  return {
    '--wp-len': len.toFixed(2),
    '--wp-dur': `${Math.round(drawMs(len))}ms`,
    '--wp-delay': `${Math.round(delayMs)}ms`,
  } as CSSProperties;
}

/** Start dot for the next stroke, with a short arrow for its initial direction. */
function StartMarker({ d, arrow }: { d: string; arrow: boolean }) {
  const s = pathStart(d);
  const dir = startDirection(d);
  const a = { x: s.x + dir.x * 5, y: s.y + dir.y * 5 };
  const b = { x: s.x + dir.x * 15, y: s.y + dir.y * 15 };
  // Arrowhead: two short barbs angled back from the tip.
  const barb = (sign: number) => {
    const angle = Math.atan2(dir.y, dir.x) + Math.PI + sign * 0.5;
    return { x: b.x + Math.cos(angle) * 4, y: b.y + Math.sin(angle) * 4 };
  };
  const l = barb(1);
  const r = barb(-1);
  return (
    <g>
      {arrow && <path className="wp-arrow" d={`M${a.x} ${a.y}L${b.x} ${b.y}M${l.x} ${l.y}L${b.x} ${b.y}L${r.x} ${r.y}`} />}
      <circle className="wp-start" cx={s.x} cy={s.y} r={3.2} />
    </g>
  );
}

export const WritingPad = forwardRef<WritingPadHandle, WritingPadProps>(function WritingPad(
  { strokes, mode, onStrokeResult, onComplete, label, showStart, leniency, disabled = false, className },
  ref,
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const liveRef = useRef<SVGPathElement>(null);
  const attempt = useRef<Attempt>(freshAttempt());
  const [, setVersion] = useState(0);
  const rerender = useCallback(() => setVersion((v) => v + 1), []);

  // The stroke in progress lives outside React state: it changes on every
  // pointer event and is painted straight into `liveRef`.
  const activePointer = useRef<{ id: number; type: string } | null>(null);
  /** Event time of the last pen contact or hover, for palm rejection. */
  const penAt = useRef(Number.NEGATIVE_INFINITY);
  const points = useRef<Point[]>([]);
  const rect = useRef<DOMRect | null>(null);
  const paintQueued = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashId = useRef(0);
  const announcementId = useRef(0);

  const callbacks = useRef({ onStrokeResult, onComplete });
  callbacks.current = { onStrokeResult, onComplete };

  const a = attempt.current;
  const done = a.accepted.length;
  const total = strokes.length;

  const resultOf = (at: Attempt, gaveUp: boolean): WritingResult => {
    const failed = new Set(at.failed);
    if (gaveUp) for (let i = at.accepted.length; i < strokes.length; i++) failed.add(i);
    return {
      mistakes: at.mistakes,
      hintsUsed: at.hinted.size,
      strokeCount: strokes.length,
      gaveUp,
      failedStrokes: failed.size,
    };
  };

  const clearFlash = () => {
    clearTimeout(flashTimer.current);
    attempt.current.flash = undefined;
  };

  const paintLive = () => {
    paintQueued.current = false;
    liveRef.current?.setAttribute('d', smoothPath(points.current));
  };

  const queuePaint = () => {
    if (paintQueued.current) return;
    paintQueued.current = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paintLive);
    else paintLive();
  };

  const resetStroke = () => {
    activePointer.current = null;
    points.current = [];
    paintQueued.current = false;
    liveRef.current?.setAttribute('d', '');
  };

  const showHint = (at: Attempt) => {
    at.hinted.add(at.accepted.length);
    at.hintRun++;
  };

  // A new node each time, so screen readers repeat a message that recurs.
  const announce = (at: Attempt, text: string) => {
    at.announcement = { id: ++announcementId.current, text };
  };

  // A new character or a new mode (trace → guided → memory) is a new attempt.
  // Layout effect so the old strokes never paint.
  const attemptKey = `${mode}:${strokes.join('|')}`;
  const shownKey = useRef(attemptKey);
  useLayoutEffect(() => {
    if (shownKey.current === attemptKey) return;
    shownKey.current = attemptKey;
    clearTimeout(flashTimer.current);
    attempt.current = freshAttempt();
    resetStroke();
    rerender();
  }, [attemptKey, rerender]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Keep the cached box current if the pad resizes mid-stroke (rotation, keyboard).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (activePointer.current !== null) rect.current = svg.getBoundingClientRect();
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  const toBox = (e: { clientX: number; clientY: number }): Point => {
    const r = rect.current;
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return { x: ((e.clientX - r.left) / r.width) * BOX, y: ((e.clientY - r.top) / r.height) * BOX };
  };

  const finishStroke = () => {
    const drawn = points.current;
    resetStroke();
    const at = attempt.current;
    if (at.status !== 'writing' || drawn.length === 0) return;

    const index = at.accepted.length;
    const accepted: AcceptedStroke[] = at.accepted.map((pts, i) => ({ points: pts, target: strokes[i] }));
    const result = matchStrokeOf(drawn, strokes, index, { frame: estimateFrame(accepted), leniency });
    // A tap can be the expected dot; anywhere else it is a stray touch, not a mistake.
    if (!result.ok && polylineLength(drawn) < TAP_LENGTH) return;

    if (result.ok) {
      clearFlash();
      at.accepted.push(drawn);
      at.tries = 0;
      at.hintRun = 0;
      const finished = at.accepted.length === strokes.length;
      announce(at, finished
        ? `Stroke ${index + 1} correct. Character complete.`
        : `Stroke ${index + 1} correct.`);
      if (finished) at.status = 'done';
      rerender();
      callbacks.current.onStrokeResult?.(index, true, result);
      if (finished) callbacks.current.onComplete?.(resultOf(at, false));
      return;
    }

    at.mistakes++;
    at.tries++;
    at.failed.add(index);
    clearFlash();
    const id = ++flashId.current;
    at.flash = { id, d: smoothPath(drawn) };
    flashTimer.current = setTimeout(() => {
      if (attempt.current.flash?.id === id) {
        attempt.current.flash = undefined;
        rerender();
      }
    }, FLASH_MS);
    const autoHint = at.tries >= AUTO_HINT_AFTER;
    if (autoHint) showHint(at);
    announce(at, `Stroke ${index + 1}: ${mistakeMessage(result, index)}${autoHint ? ` Showing stroke ${index + 1}.` : ''}`);
    rerender();
    callbacks.current.onStrokeResult?.(index, false, result);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'pen') penAt.current = e.timeStamp;
    if (disabled || attempt.current.status !== 'writing' || strokes.length === 0) return;
    const active = activePointer.current;
    if (active) {
      // The same pointer pressing again, or a new first contact of the same
      // kind, means the active stroke's pointerup never arrived (it was lifted
      // outside the pad without capture): drop that stroke rather than locking up.
      const stale = e.pointerId === active.id || (e.isPrimary && e.pointerType === active.type);
      if (!stale) return; // a second finger: ignore it
      resetStroke();
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A palm resting while writing with a pen. Only while the pen is in use, so fingers work again after.
    if (e.pointerType === 'touch' && e.timeStamp - penAt.current < PALM_REJECT_MS) return;
    e.preventDefault();

    const svg = e.currentTarget;
    try {
      svg.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is a nicety; strokes still work without it.
    }
    activePointer.current = { id: e.pointerId, type: e.pointerType };
    rect.current = svg.getBoundingClientRect();
    points.current = [toBox(e)];
    if (attempt.current.flash) {
      clearFlash();
      rerender();
    }
    queuePaint();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'pen') penAt.current = e.timeStamp; // touching or hovering
    if (e.pointerId !== activePointer.current?.id) return;
    const native = e.nativeEvent;
    const coalesced = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const samples = coalesced.length ? coalesced : [native];
    const pts = points.current;
    for (const s of samples) {
      const p = toBox(s);
      if (pts.length === 0 || distance(pts[pts.length - 1], p) >= MIN_SAMPLE_GAP) pts.push(p);
    }
    queuePaint();
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'pen') penAt.current = e.timeStamp;
    if (e.pointerId !== activePointer.current?.id) return;
    const last = toBox(e);
    const pts = points.current;
    if (pts.length === 0 || distance(pts[pts.length - 1], last) >= MIN_SAMPLE_GAP) pts.push(last);
    finishStroke();
  };

  // Cancelled by the system (a gesture took over), or capture taken away mid-stroke,
  // after which the pointerup may never reach the pad: drop the stroke.
  const onPointerAbort = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerId === activePointer.current?.id) resetStroke();
  };

  useImperativeHandle(ref, () => ({
    undo() {
      const at = attempt.current;
      if (at.status !== 'writing' || at.accepted.length === 0) return;
      at.accepted.pop();
      at.tries = 0;
      at.hintRun = 0;
      clearFlash();
      announce(at, `Stroke ${at.accepted.length + 1} removed.`);
      rerender();
    },
    clear() {
      const at = attempt.current;
      resetStroke();
      clearFlash();
      if (at.status !== 'writing') {
        attempt.current = freshAttempt();
      } else {
        at.accepted = [];
        at.tries = 0;
        at.hintRun = 0;
      }
      announce(attempt.current, 'Cleared.');
      rerender();
    },
    hint() {
      const at = attempt.current;
      if (at.status !== 'writing' || at.accepted.length >= strokes.length) return;
      showHint(at);
      announce(at, `Showing stroke ${at.accepted.length + 1}.`);
      rerender();
    },
    giveUp() {
      const at = attempt.current;
      if (at.status !== 'writing') return;
      resetStroke();
      clearFlash();
      at.status = 'gaveUp';
      at.hintRun = 0;
      announce(at, 'Showing the whole character.');
      rerender();
      callbacks.current.onComplete?.(resultOf(at, true));
    },
  }));

  const next = a.status === 'writing' ? strokes[done] : undefined;
  // The start marker also accompanies a hint, in every mode.
  const markerVisible = next !== undefined && (a.hintRun > 0 || (showStart ?? mode !== 'memory'));

  const who = label ? `Writing pad for ${label}` : 'Writing pad';
  let progress = `${done} of ${total} strokes drawn`;
  if (a.status === 'done') progress += ', complete';
  else if (a.status === 'gaveUp') progress += ', answer shown';
  else if (a.hintRun > 0) progress += `; stroke ${done + 1} hint shown`;

  let revealDelay = 0;

  return (
    <div className={className ? `writing-pad ${className}` : 'writing-pad'} aria-disabled={disabled || undefined}>
      <svg
        ref={svgRef}
        role="img"
        aria-label={`${who}: ${progress}`}
        viewBox={`0 0 ${BOX} ${BOX}`}
        style={{ '--wp-width': inkWidth(total) } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerAbort}
        onLostPointerCapture={onPointerAbort}
        onContextMenu={(e) => e.preventDefault()}
      >
        <path className="wp-guide" d={`M${BOX / 2} 0V${BOX}M0 ${BOX / 2}H${BOX}`} />

        {mode === 'trace' && (
          <g className="wp-stroke wp-ghost">
            {strokes.map((d, i) => <path key={i} d={d} />)}
          </g>
        )}

        <g className="wp-stroke wp-ink">
          {a.accepted.map((_, i) => <path key={i} d={strokes[i]} />)}
        </g>

        {a.status === 'gaveUp' && (
          <g className="wp-stroke">
            {strokes.slice(done).map((d, i) => {
              const style = drawStyle(d, revealDelay);
              revealDelay += drawMs(pathLength(d)) + 120;
              return <path key={i} d={d} className="wp-reveal" style={style} />;
            })}
          </g>
        )}

        {next !== undefined && a.hintRun > 0 && (
          <path key={`hint-${done}-${a.hintRun}`} className="wp-stroke wp-hint" d={next} style={drawStyle(next)} />
        )}

        {/* While a hint is drawing the stroke, the moving line shows the direction. */}
        {markerVisible && <StartMarker d={next} arrow={a.hintRun === 0} />}

        {a.flash && <path key={a.flash.id} className="wp-stroke wp-flash" d={a.flash.d} />}

        <path ref={liveRef} className="wp-live" d="" />
      </svg>
      <p className="visually-hidden" aria-live="polite"><span key={a.announcement.id}>{a.announcement.text}</span></p>
    </div>
  );
});
