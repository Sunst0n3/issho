// The kanji page's parts panel: the kanji it is built from (each with its own page) and the named
// parts that are not kanji of their own (氵 "water (side)"), with their names.
import { Link } from 'react-router-dom';
import type { KanjiEntry, RadicalEntry } from '../../lib/types.ts';
import { Glyph } from '../Glyph.tsx';

export interface PartView {
  char: string;
  name: string;
  /** A kanji of the course (it has its own page). */
  kanji: boolean;
  /** Named part only: the full kanji it is a form of. */
  variantOf?: string;
}

/** pure: components first (curriculum kanji), then named parts, without repeats. */
export function partsOf(entry: KanjiEntry, kanji: Readonly<Record<string, KanjiEntry>>, radicals: ReadonlyMap<string, RadicalEntry>): PartView[] {
  const seen = new Set<string>();
  const out: PartView[] = [];
  for (const c of entry.components) {
    if (seen.has(c) || c === entry.char) continue;
    seen.add(c);
    out.push({ char: c, name: kanji[c]?.meanings[0] ?? radicals.get(c)?.name ?? '', kanji: Boolean(kanji[c]) });
  }
  for (const p of entry.parts) {
    if (seen.has(p) || p === entry.char) continue;
    seen.add(p);
    const r = radicals.get(p);
    out.push({ char: p, name: r?.name ?? '', kanji: false, variantOf: r?.variantOf });
  }
  return out;
}

export function PartsPanel({ parts }: { parts: readonly PartView[] }) {
  if (!parts.length) return null;
  return (
    <section className="kd-section" aria-labelledby="kd-parts-title">
      <h2 id="kd-parts-title" className="hm-section-title">Parts</h2>
      <ul className="card kd-parts">
        {parts.map((p) => {
          const body = (
            <>
              <span className="kd-part-glyph"><Glyph char={p.char} size={30} /></span>
              <span className="kd-part-text">
                <span className="kd-part-name">{p.name || 'part'}</span>
                <span className="hm-hint">
                  {p.kanji ? 'kanji' : 'named part'}
                  {p.variantOf && <> · a form of <span lang="ja">{p.variantOf}</span></>}
                </span>
              </span>
            </>
          );
          return (
            <li key={p.char}>
              {p.kanji || p.name ? (
                <Link to={`/kanji/${encodeURIComponent(p.char)}`} className="kd-part" aria-label={`${p.char}, ${p.name || 'part'}`}>
                  {body}
                </Link>
              ) : (
                <div className="kd-part">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
