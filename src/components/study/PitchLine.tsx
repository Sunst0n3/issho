// Pitch accent as a height line over the moras (never H/L letters): each mora is a dot, high or low, joined by a
// line, with the mora written under it.
// Heiban and odaka words sound the same alone; the trailing particle dot shows the difference (が stays high after a
// heiban word and drops after an odaka one).

import { splitMoras } from '../../../shared/voicevox.ts';
import type { AccentInfo, AccentType } from '../../lib/types.ts';

/** pure: high (true) or low per mora for an accent nucleus `drop` (0 = no drop), then the following particle's level. */
export function moraLevels(count: number, drop: number): { moras: boolean[]; particle: boolean } {
  const moras = Array.from({ length: count }, (_, i) => {
    if (drop === 1) return i === 0;
    if (i === 0) return false;
    return drop === 0 || i < drop;
  });
  return { moras, particle: drop === 0 };
}

const TYPE_NAMES: Record<AccentType, string> = {
  heiban: 'flat: low, then high, and the particle stays high',
  atamadaka: 'high first mora, then low',
  nakadaka: 'rises, then drops inside the word',
  odaka: 'rises and stays high, then the particle drops',
};

const SIZES = { sm: { step: 22, high: 6, low: 20, label: 34, r: 3.2 }, md: { step: 30, high: 8, low: 28, label: 46, r: 4 } } as const;

export function PitchLine({ accent, kana, size = 'md', particle = false }: {
  accent: AccentInfo;
  /** Display moras (hiragana) when they line up with the accent's moras; else the accent's katakana moras. */
  kana?: string;
  size?: 'sm' | 'md';
  /** Draw the following が as a full mora (the pitch drill), for every accent type. */
  particle?: boolean;
}) {
  const n = accent.moras.length;
  const fromKana = kana ? splitMoras(kana) : [];
  const labels = fromKana.length === n ? fromKana : accent.moras;
  const levels = moraLevels(n, accent.drop);
  // The particle dot only where it tells the type apart (heiban vs odaka), unless the drill asks for a full が.
  const showParticle = particle || accent.type === 'heiban' || accent.type === 'odaka';
  const s = SIZES[size];
  const count = n + (showParticle ? 1 : 0);
  const width = count * s.step;
  const height = s.label + 4;
  const x = (i: number) => s.step / 2 + i * s.step;
  const y = (high: boolean) => (high ? s.high : s.low);
  const points = levels.moras.map((h, i) => `${x(i)},${y(h)}`);
  if (showParticle) points.push(`${x(n)},${y(levels.particle)}`);
  return (
    <svg className={`st-pitch st-pitch-${size}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`Pitch: ${TYPE_NAMES[accent.type]}`} data-type={accent.type}>
      <polyline className="st-pitch-line" points={points.join(' ')} />
      {levels.moras.map((h, i) => <circle key={i} className="st-pitch-dot" cx={x(i)} cy={y(h)} r={s.r} />)}
      {showParticle && <circle className="st-pitch-dot particle" cx={x(n)} cy={y(levels.particle)} r={s.r} />}
      {labels.map((m, i) => (
        <text key={i} className="st-pitch-mora" x={x(i)} y={s.label} textAnchor="middle" lang="ja">{m}</text>
      ))}
      {particle && <text className="st-pitch-mora particle" x={x(n)} y={s.label} textAnchor="middle" lang="ja">が</text>}
    </svg>
  );
}
