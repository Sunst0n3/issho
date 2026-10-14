// Stroke-order displays: a strip of frames (one per stroke, as in the mockup)
// and an animation that draws the character stroke by stroke.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Icon } from '../components/ui.tsx';
import { BOX, inkWidth, pathLength } from './path.ts';
import './writing.css';

/**
 * One frame per stroke: strokes already written in ink, the stroke being
 * taught in shu, the rest faint, with the stroke number in the corner.
 */
export function StrokeOrderStrip({ strokes, label, className }: {
  strokes: readonly string[];
  /** Accessible name for the list, e.g. "Stroke order for 水". */
  label?: string;
  className?: string;
}) {
  const n = strokes.length;
  const style = { '--cols': Math.min(5, Math.max(4, n)) } as CSSProperties;
  // Small frames need a heavier brush than the full-size pad.
  const width = inkWidth(n, 8);
  return (
    <ol className={className ? `stroke-strip ${className}` : 'stroke-strip'} style={style}
      aria-label={label ?? `Stroke order, ${n} ${n === 1 ? 'stroke' : 'strokes'}`}>
      {strokes.map((_, k) => (
        <li key={k} className="stroke-frame">
          <span className="stroke-badge" aria-hidden="true">{k + 1}</span>
          <svg role="img" aria-label={`Stroke ${k + 1} of ${n}`} viewBox={`0 0 ${BOX} ${BOX}`} strokeWidth={width}>
            {strokes.map((d, i) => (
              <path key={i} d={d} className={i < k ? 'done' : i === k ? 'current' : 'todo'} />
            ))}
          </svg>
        </li>
      ))}
    </ol>
  );
}

/** Model units drawn per second at speed 1. */
const UNITS_PER_SECOND = 90;
const MIN_STROKE_MS = 300;
const GAP_MS = 220;
const LOOP_PAUSE_MS = 1200;

interface Timing {
  len: number;
  dur: number;
  delay: number;
}

function timings(strokes: readonly string[], speed: number): { list: Timing[]; total: number } {
  const pace = Math.max(0.1, speed);
  let t = 0;
  const list = strokes.map((d) => {
    // Slightly longer than measured so no sliver is left undrawn.
    const len = pathLength(d) + 2;
    const dur = Math.max(MIN_STROKE_MS, (len / UNITS_PER_SECOND) * 1000) / pace;
    const timing = { len, dur, delay: t };
    t += dur + GAP_MS / pace;
    return timing;
  });
  return { list, total: t };
}

/**
 * Draws the character stroke by stroke over a faint copy. The stroke being
 * drawn is shu and settles into ink. A button replays it.
 */
export function StrokeAnimation({ strokes, autoPlay = true, loop = false, speed = 1, label, className }: {
  strokes: readonly string[];
  autoPlay?: boolean;
  loop?: boolean;
  /** 1 = natural pace; 2 = twice as fast. */
  speed?: number;
  /** What is being drawn, for the accessible name. */
  label?: string;
  className?: string;
}) {
  // `run` > 0 means an animation is (or was) playing; bumping it restarts it.
  const [run, setRun] = useState(autoPlay ? 1 : 0);
  const [playing, setPlaying] = useState(autoPlay);
  const { list, total } = useMemo(() => timings(strokes, speed), [strokes, speed]);

  // A different character starts over (playing again when autoplaying).
  const key = strokes.join('|');
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setRun((r) => (autoPlay ? r + 1 : 0));
    setPlaying(autoPlay);
  }

  useEffect(() => {
    if (!playing || run === 0) return;
    const end = setTimeout(() => setPlaying(false), total);
    return () => clearTimeout(end);
  }, [playing, run, total]);

  useEffect(() => {
    if (!loop || playing || run === 0) return;
    const again = setTimeout(() => {
      setRun((r) => r + 1);
      setPlaying(true);
    }, LOOP_PAUSE_MS);
    return () => clearTimeout(again);
  }, [loop, playing, run]);

  const replay = () => {
    setRun((r) => r + 1);
    setPlaying(true);
  };

  const name = label ? `Stroke order animation for ${label}` : 'Stroke order animation';
  return (
    <div className={className ? `stroke-anim ${className}` : 'stroke-anim'}>
      <svg className="sa-canvas" role="img" aria-label={`${name}, ${strokes.length} strokes`} viewBox={`0 0 ${BOX} ${BOX}`}
        style={{ '--wp-width': inkWidth(strokes.length) } as CSSProperties}>
        <g className="sa-ghost">
          {strokes.map((d, i) => <path key={i} d={d} />)}
        </g>
        {run === 0 ? (
          <g className="sa-ink">
            {strokes.map((d, i) => <path key={i} d={d} />)}
          </g>
        ) : (
          <g key={run}>
            {strokes.map((d, i) => (
              <path key={i} d={d} className="sa-run" style={{
                '--wp-len': list[i].len.toFixed(2),
                '--wp-dur': `${Math.round(list[i].dur)}ms`,
                '--wp-delay': `${Math.round(list[i].delay)}ms`,
              } as CSSProperties} />
            ))}
          </g>
        )}
      </svg>
      <button type="button" className="icon-btn outlined sa-replay" onClick={replay}
        aria-label={run === 0 ? 'Play stroke order' : 'Replay stroke order'}>
        <Icon name={run === 0 ? 'play' : 'refresh'} size={18} />
      </button>
    </div>
  );
}
