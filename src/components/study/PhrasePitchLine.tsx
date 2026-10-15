// The pitch of a whole sentence as VOICEVOX read it: one small height line per accent phrase, with a gap between
// phrases. Within a phrase the first mora is low unless the accent is on it, then high up to the accent, low after.

import { splitMoras } from '../../../shared/voicevox.ts';
import type { ClipAccentPhrase } from '../../lib/types.ts';

/** pure: high (true) or low per mora of one accent phrase with its 1-based accent nucleus. */
export function phraseLevels(count: number, accent: number): boolean[] {
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return accent === 1;
    return i < accent;
  });
}

const STEP = 18;
const GAP = 14;
const HIGH = 6;
const LOW = 18;
const LABEL = 34;

export function PhrasePitchLine({ phrases }: { phrases: readonly ClipAccentPhrase[] }) {
  if (!phrases.length) return null;
  let at = STEP / 2;
  const groups = phrases.map(([moraText, accent]) => {
    const moras = splitMoras(moraText);
    const levels = phraseLevels(moras.length, accent);
    const xs = moras.map((_, i) => at + i * STEP);
    at += moras.length * STEP + GAP;
    return { moras, levels, xs };
  });
  const width = Math.max(STEP, at - GAP);
  return (
    <div className="st-phrase-pitch">
      <svg width={width} height={LABEL + 4} viewBox={`0 0 ${width} ${LABEL + 4}`} role="img"
        aria-label={`Sentence pitch, ${phrases.length} ${phrases.length === 1 ? 'phrase' : 'phrases'}`}>
        {groups.map((g, k) => (
          <g key={k} className="st-pitch-phrase">
            <polyline className="st-pitch-line" points={g.xs.map((x, i) => `${x},${g.levels[i] ? HIGH : LOW}`).join(' ')} />
            {g.xs.map((x, i) => <circle key={i} className="st-pitch-dot" cx={x} cy={g.levels[i] ? HIGH : LOW} r={2.8} />)}
            {g.moras.map((m, i) => (
              <text key={i} className="st-pitch-mora" x={g.xs[i]} y={LABEL} textAnchor="middle" lang="ja">{m}</text>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
