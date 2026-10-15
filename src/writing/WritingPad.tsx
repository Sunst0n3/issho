// The handwriting canvas. The learner writes with a finger, pen or mouse.
// Trace, guided and memory modes check each finished stroke against the next
// expected KanjiVG stroke: a correct stroke snaps to the clean model stroke in
// ink; a wrong one flashes shu and disappears. Buttons (undo, hint, clear, give
// up) live in the screen and drive the pad through its imperative handle.
//
// Recall mode (review cards) judges the whole character at once: the ink stays
// as drawn with no marks, no model and no animation until "Done"; then the
// strokes are matched in any order (matchCharacterUnordered), the model is drawn
// over the ink and stroke-order slips get a coaching note.

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
import { useSettings } from '../lib/hooks.ts';
import { mistakeMessage, orderNotes } from './describe.ts';
import {
  estimateFrame,
  matchCharacterUnordered,
  matchStrokeOf,
  STYLUS_LENIENCY,
  type AcceptedStroke,
  type Frame,
  type StrokeAttempt,
  type UnorderedMatch,
} from './matcher.ts';
import { BOX, distance, inkWidth, pathLength, pathStart, polylineLength, smoothPath, startDirection, type Point } from './path.ts';
import './writing.css';

export type WritingMode = 'trace' | 'guided' | 'memory' | 'recall';

/** What a recall attempt produced, reported once by "Done". */
export interface RecallResult {
  /** The strokes as drawn, in the order drawn (box units). */
  strokes: Point[][];
  match: UnorderedMatch;
  /** Hint was used during the attempt. */
  hintUsed: boolean;
}

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
  /** Reveals the remaining strokes and finishes the attempt (recall: the same as done). */
  giveUp(): void;
  /** Recall mode: judges what is drawn and reports it through onRecallDone. */
  done(): void;
}

export interface WritingPadProps {
  /** KanjiVG stroke paths in stroke order. */
  strokes: readonly string[];
  /** Changing the mode (or the strokes) starts a new attempt, so trace → guided → memory can reuse one pad. */
  mode: WritingMode;
  /** Called after every checked stroke; `detail` says why a stroke was rejected. */
  onStrokeResult?: (index: number, ok: boolean, detail: StrokeAttempt) => void;
  /** Called once, after the last stroke or on give-up (trace, guided and memory). */
  onComplete?: (result: WritingResult) => void;
  /** Recall mode: called once, when the learner taps Done. */
  onRecallDone?: (result: RecallResult) => void;
  /** Recall mode: the Done button's text. */
  doneLabel?: string;
  /** What is being written, for the accessible name ("水", "the kanji for water"). */
  label?: string;
  /** Show the next stroke's start dot and direction arrow. Defaults to on, except in memory and recall modes. */
  showStart?: boolean;
  /**
   * Matcher tolerance multiplier (see MatchOptions.leniency). Defaults to the learner's
   * Settings → I write with: STYLUS_LENIENCY for a stylus, 1 for a finger.
   */
  leniency?: number;
  disabled?: boolean;
  className?: string;
}

/** A second miss on the same stroke shows it automatically. */
export const AUTO_HINT_AFTER = 2;

export { STYLUS_LENIENCY };
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
  /** Recall mode: every stroke as drawn, unchecked. */
  ink: Point[][];
  /** Recall mode: the judgement once Done was tapped. */
  recall?: UnorderedMatch;
  /** Recall mode: bumping it replays the model's stroke order over the ink. */
  replay: number;
}

function freshAttempt(): Attempt {
  return {
    ink: [],
    replay: 0,
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

/** The model placed where the learner wrote it: the frame estimated from the strokes that matched. */
function recallFrame(strokes: readonly string[], ink: readonly Point[][], match: UnorderedMatch): Frame {
  const accepted: AcceptedStroke[] = [];
  match.assignment.forEach((j, i) => {
    if (j !== null && !match.unmatched.includes(i) && ink[j]) accepted.push({ points: ink[j], target: strokes[i] });
  });
  return estimateFrame(accepted);
}

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
  { strokes, mode, onStrokeResult, onComplete, onRecallDone, doneLabel = 'Done', label, showStart, leniency, disabled = false, className },
  ref,
) {
  const recallMode = mode === 'recall';
  const { writingHand } = useSettings();
  const effectiveLeniency = leniency ?? (writingHand === 'stylus' ? STYLUS_LENIENCY : 1);
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

  const callbacks = useRef({ onStrokeResult, onComplete, onRecallDone });
  callbacks.current = { onStrokeResult, onComplete, onRecallDone };

  const a = attempt.current;
  const done = recallMode ? Math.min(a.ink.length, strokes.length) : a.accepted.length;
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
    at.hinted.add(recallMode ? at.ink.length : at.accepted.length);
    at.hintRun++;
  };

  /** Recall: judge the whole character, draw the model over the ink and report it. */
  const finishRecall = () => {
    const at = attempt.current;
    if (at.status !== 'writing') return;
    resetStroke();
    const match = matchCharacterUnordered(strokes, at.ink, { leniency: effectiveLeniency });
    at.status = 'done';
    at.recall = match;
    at.hintRun = 0;
    announce(at, match.ok ? 'Done. The model is drawn over your writing.' : 'Done. Compare your writing with the model.');
    rerender();
    callbacks.current.onRecallDone?.({ strokes: at.ink.map((pts) => [...pts]), match, hintUsed: at.hinted.size > 0 });
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

    if (recallMode) {
      // Kept exactly as drawn: no check, no snapping, nothing that hints at the answer.
      at.ink.push(drawn);
      at.hintRun = 0;
      announce(at, `${at.ink.length} ${at.ink.length === 1 ? 'stroke' : 'strokes'} drawn.`);
      rerender();
      return;
    }

    const index = at.accepted.length;
    const accepted: AcceptedStroke[] = at.accepted.map((pts, i) => ({ points: pts, target: strokes[i] }));
    const result = matchStrokeOf(drawn, strokes, index, { frame: estimateFrame(accepted), leniency: effectiveLeniency });
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
    // "Watch the hint" only when a hint is drawn for this stroke.
    announce(at, `Stroke ${index + 1}: ${mistakeMessage(result, index, autoHint || at.hintRun > 0)}${autoHint ? ` Showing stroke ${index + 1}.` : ''}`);
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

  const handle = useRef<WritingPadHandle | null>(null);
  useImperativeHandle(ref, () => handle.current as WritingPadHandle);
  handle.current = ({
    undo() {
      const at = attempt.current;
      if (recallMode) {
        if (at.status !== 'writing' || at.ink.length === 0) return;
        at.ink.pop();
        at.hintRun = 0;
        announce(at, `Stroke ${at.ink.length + 1} removed.`);
        rerender();
        return;
      }
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
        at.ink = [];
        at.accepted = [];
        at.tries = 0;
        at.hintRun = 0;
      }
      announce(attempt.current, 'Cleared.');
      rerender();
    },
    hint() {
      const at = attempt.current;
      const drawnCount = recallMode ? at.ink.length : at.accepted.length;
      if (at.status !== 'writing' || drawnCount >= strokes.length) return;
      showHint(at);
      announce(at, `Showing stroke ${drawnCount + 1}.`);
      rerender();
    },
    done() {
      if (recallMode) finishRecall();
    },
    giveUp() {
      const at = attempt.current;
      if (recallMode) {
        finishRecall();
        return;
      }
      if (at.status !== 'writing') return;
      resetStroke();
      clearFlash();
      at.status = 'gaveUp';
      at.hintRun = 0;
      announce(at, 'Showing the whole character.');
      rerender();
      callbacks.current.onComplete?.(resultOf(at, true));
    },
  });

  const next = a.status === 'writing' ? strokes[done] : undefined;
  // The start marker also accompanies a hint, in every mode.
  const markerVisible = next !== undefined && (a.hintRun > 0 || (showStart ?? (mode !== 'memory' && !recallMode)));

  const who = label ? `Writing pad for ${label}` : 'Writing pad';
  // Recall never says how many strokes the character has: that would be a hint.
  let progress = recallMode ? `${a.ink.length} ${a.ink.length === 1 ? 'stroke' : 'strokes'} drawn` : `${done} of ${total} strokes drawn`;
  if (a.status === 'done') progress += recallMode ? ', model shown' : ', complete';
  else if (a.status === 'gaveUp') progress += ', answer shown';
  else if (a.hintRun > 0) progress += `; stroke ${done + 1} hint shown`;

  let revealDelay = 0;
  const recalled = recallMode && a.status === 'done' && a.recall ? a.recall : undefined;
  const frame = recalled ? recallFrame(strokes, a.ink, recalled) : undefined;
  const notes = recalled ? orderNotes(recalled) : [];
  let replayDelay = 0;

  const pad = (
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
          {recallMode && a.ink.map((pts, i) => <path key={i} className="wp-raw" d={smoothPath(pts)} />)}
        </g>

        {recalled && frame && (
          <g className="wp-stroke wp-model" transform={`matrix(${frame.scale} 0 0 ${frame.scale} ${frame.dx} ${frame.dy})`}
            data-testid="recall-model">
            {a.replay > 0
              ? strokes.map((d, i) => {
                const style = drawStyle(d, replayDelay);
                replayDelay += drawMs(pathLength(d)) + 120;
                return <path key={`${a.replay}-${i}`} d={d} className="wp-reveal" style={style} />;
              })
              : strokes.map((d, i) => <path key={i} d={d} />)}
          </g>
        )}

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
  if (!recallMode) return pad;

  return (
    <div className="wp-recall">
      {pad}
      {recallMode && a.status === 'writing' && (
        <div className="wp-recall-tools">
          <button type="button" className="btn secondary small" disabled={disabled || a.ink.length === 0}
            onClick={() => handle.current?.undo()}>Undo</button>
          <button type="button" className="btn secondary small" disabled={disabled}
            onClick={() => handle.current?.hint()}>Hint</button>
          <button type="button" className="btn secondary small" disabled={disabled || a.ink.length === 0}
            onClick={() => handle.current?.clear()}>Clear</button>
          <button type="button" className="btn ink wp-done" disabled={disabled || a.ink.length === 0} onClick={finishRecall}>
            {doneLabel}
          </button>
        </div>
      )}
      {recalled && notes.length > 0 && (
        <ul className="wp-notes" aria-label="Stroke order">
          {notes.map((n) => (
            <li key={`${n.first}-${n.then}`}>
              <span>{n.text}</span>
              <button type="button" className="btn ghost small" onClick={() => {
                attempt.current.replay++;
                rerender();
              }}>Replay</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
