// The pitch of a whole sentence as VOICEVOX read it: one small height line per accent phrase, with a gap between
// phrases. Within a phrase the first mora is low unless the accent is on it, then high up to the accent, low after.
// The moras are labelled in the sentence's own spelling (あのひとは, おとうさん), not the engine's katakana as spoken
// (アノヒトワ, オトオサン): the engine's moras line up one to one with the spelling in VOICEVOX's comparison form.

import { normalizeMoras, rubyKana, splitMoras } from '../../../shared/voicevox.ts';
import type { ClipAccentPhrase } from '../../lib/types.ts';

/** pure: high (true) or low per mora of one accent phrase with its 1-based accent nucleus. */
export function phraseLevels(count: number, accent: number): boolean[] {
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return accent === 1;
    return i < accent;
  });
}

/** Punctuation, symbols and spaces are never moras (as in normalizeMoras). */
const NOT_MORA_RE = /[\p{P}\p{S}\p{Z}\s]/gu;

const toHiragana = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/**
 * pure: the mora labels of each accent phrase. With `text` (the sentence, ruby markup allowed), its kana spelling
 * when that spelling lines up mora for mora with the engine's moras (は and を as written, おとうさん's う, katakana
 * words in katakana); otherwise, or without `text`, the engine's moras in hiragana.
 */
export function phraseLabels(phrases: readonly ClipAccentPhrase[], text?: string): string[][] {
  const spoken = phrases.map(([moraText]) => splitMoras(moraText));
  const fallback = spoken.map((moras) => moras.map(toHiragana));
  if (!text) return fallback;
  const spelled = splitMoras(rubyKana(text).normalize('NFKC').replace(NOT_MORA_RE, ''));
  const flat = spoken.flat();
  if (spelled.length !== flat.length || normalizeMoras(spelled.join('')) !== normalizeMoras(flat.join(''))) return fallback;
  let at = 0;
  return spoken.map((moras) => {
    const labels = spelled.slice(at, at + moras.length);
    at += moras.length;
    return labels;
  });
}

const STEP = 18;
const GAP = 14;
const HIGH = 6;
const LOW = 18;
const LABEL = 34;

export function PhrasePitchLine({ phrases, text }: {
  phrases: readonly ClipAccentPhrase[];
  /** The sentence as the learner reads it (ruby markup allowed): the labels follow its spelling. */
  text?: string;
}) {
  if (!phrases.length) return null;
  const labels = phraseLabels(phrases, text);
  let at = STEP / 2;
  const groups = phrases.map(([, accent], k) => {
    const moras = labels[k];
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
