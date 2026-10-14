// Shared React hooks over local data.
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { DEFAULT_SETTINGS, db } from './db.ts';
import { isKanji } from './ruby.ts';
import type { Settings } from './types.ts';

/** Live settings with defaults filled in (defaults while IndexedDB is loading). */
export function useSettings(): Settings {
  const stored = useLiveQuery(() => db.settings.get('me'), []);
  return useMemo(() => ({ ...DEFAULT_SETTINGS, ...stored }), [stored]);
}

/** True once settings have been read from IndexedDB (to avoid redirect flashes). */
export function useSettingsLoaded(): boolean {
  return useLiveQuery(async () => { await db.settings.get('me'); return true; }, [], false);
}

/** Every kanji the learner has been introduced to, live. */
export function useKnownKanji(): Set<string> {
  const keys = useLiveQuery(
    () => db.items.where('kind').equals('kanji').primaryKeys(),
    [],
  );
  return useMemo(() => new Set((keys ?? []).map((id) => String(id).slice('kanji:'.length))), [keys]);
}

/**
 * The `show` predicate for <Ruby>, following settings.furigana:
 * 'always' → every reading, 'never' → none,
 * 'unknown' → readings only on words containing a kanji the learner hasn't met yet.
 */
export function useRubyShow(): 'all' | 'none' | ((base: string) => boolean) {
  const { furigana } = useSettings();
  const known = useKnownKanji();
  return useMemo(() => {
    if (furigana === 'always') return 'all';
    if (furigana === 'never') return 'none';
    return (base: string) => [...base].some((ch) => isKanji(ch) && !known.has(ch));
  }, [furigana, known]);
}
