// Stroke paths for one character from public/data/strokes.json.

import { useEffect, useState } from 'react';
import { strokesFor } from '../lib/data.ts';

export interface StrokesState {
  strokes?: string[];
  loading: boolean;
  /** KanjiVG has no strokes for this character. */
  missing: boolean;
  /** The stroke data could not be loaded at all. */
  error?: Error;
}

// Resolved lookups (null = not in KanjiVG), so revisiting a character renders
// its strokes immediately instead of flashing a loading state.
const resolved = new Map<string, string[] | null>();

function lookup(char: string | undefined): StrokesState {
  if (!char) return { loading: false, missing: false };
  const hit = resolved.get(char);
  if (hit === undefined) return { loading: true, missing: false };
  return hit ? { strokes: hit, loading: false, missing: false } : { loading: false, missing: true };
}

export function useStrokes(char: string | undefined): StrokesState {
  const [entry, setEntry] = useState(() => ({ char, state: lookup(char) }));

  useEffect(() => {
    if (!char || resolved.has(char)) {
      setEntry((e) => (e.char === char && !e.state.loading ? e : { char, state: lookup(char) }));
      return;
    }
    let live = true;
    strokesFor(char).then(
      (strokes) => {
        resolved.set(char, strokes ?? null);
        if (live) setEntry({ char, state: lookup(char) });
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (live) setEntry({ char, state: { loading: false, missing: false, error } });
      },
    );
    return () => {
      live = false;
    };
  }, [char]);

  // Never show the previous character's strokes for a frame after `char` changes.
  return entry.char === char ? entry.state : lookup(char);
}
