// Turns JMdict glosses into short English answers for quizzes.

/** Glosses longer than this are only kept when nothing shorter exists. */
const LONG_GLOSS = 40;

const PAREN_RE = /\s*\([^()]*\)/g;

/**
 * A leading parenthetical that carries the meaning rather than a note:
 * "(not) at all" (全然), "(how) many times" (何度). Dropping it would invert
 * or change the answer, so its word is kept.
 */
const MEANINGFUL_LEAD_RE = /^\((not|no|never|nothing|none|how|what|why|who|where|when|which)\)\s*/i;

/**
 * "water (esp. cool or cold)" → "water"; "(one's) mother" → "mother";
 * "(not) at all" → "not at all".
 * When the gloss is nothing but a parenthetical, its contents are kept instead.
 */
export function cleanGloss(gloss: string): string {
  let s = gloss.replace(MEANINGFUL_LEAD_RE, '$1 ');
  // Parentheticals can nest ("(of a (small) child)"), so strip innermost first.
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(PAREN_RE, '');
  }
  s = tidy(s);
  return s || tidy(gloss.replace(/[()]/g, ''));
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:!?.])/g, '$1')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .trim();
}

/** Cleaned, de-duplicated glosses, short ones preferred, at most `max`. */
export function cleanGlosses(glosses: string[], max = 3): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const g of glosses) {
    const c = cleanGloss(g);
    const key = c.toLowerCase();
    if (!c || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(c);
  }
  const short = cleaned.filter((g) => g.length <= LONG_GLOSS);
  return (short.length > 0 ? short : cleaned.slice(0, 1)).slice(0, max);
}
