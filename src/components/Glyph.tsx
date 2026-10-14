import { useStrokes } from '../writing/useStrokes.ts';

// CJK Radicals Supplement and Kangxi Radicals: web fonts often lack these
// (⻌ ⻖ ⺨ …), so they are drawn from KanjiVG strokes instead of as text.
const RADICAL_BLOCK = /[⺀-⻿⼀-⿟]/u;

/**
 * A single character in the display face. Radical code points that fonts may not
 * cover are drawn from their stroke data so they never show as tofu boxes.
 */
export function Glyph({ char, size, className }: { char: string; size: number; className?: string }) {
  const drawn = RADICAL_BLOCK.test(char);
  const { strokes } = useStrokes(drawn ? char : undefined);
  if (drawn && strokes) {
    return (
      <svg role="img" aria-label={char} width={size} height={size} viewBox="0 0 109 109" className={className}
        fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round">
        {strokes.map((d, i) => <path key={i} d={d} />)}
      </svg>
    );
  }
  return (
    <span lang="ja" className={className}
      style={{ fontFamily: 'var(--font-display)', fontSize: size, lineHeight: 1, display: 'inline-block' }}>
      {char}
    </span>
  );
}
