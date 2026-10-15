// Shared React hooks over local data, and the furigana policy.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { loadWordInfo, type WordInfo } from './data.ts';
import { DEFAULT_SETTINGS, db } from './db.ts';
import { isKanji } from './ruby.ts';
import type { CardRecord, Settings } from './types.ts';

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

// ---------------------------------------------------------------------------
// Furigana
// ---------------------------------------------------------------------------

/** A word's read card is mature from this stability (days): its reading is no longer shown over it. */
export const MATURE_STABILITY_DAYS = 21;

export interface FuriganaPolicy {
  /** Tokens: show the reading over a kanji-bearing token unless its ref's read card is mature. Names: always. */
  forRef(ref: string | undefined, hasKanji: boolean, isName?: boolean): boolean;
  /** Ruby text: exact `${written}|${kana}` of a mature word hides it; also a mature word whose written starts with
   *  base and whose kana starts with reading (okurigana: {食|た}べる). Otherwise shown. */
  forRuby(base: string, reading: string): boolean;
}

const ALWAYS: FuriganaPolicy = { forRef: () => true, forRuby: () => true };
const NEVER: FuriganaPolicy = { forRef: () => false, forRuby: () => false };

/** pure: settings 'always' → always true; 'never' → false; 'unknown' → per maturity sets. */
export function furiganaPolicy(
  furigana: Settings['furigana'],
  matureRefs: ReadonlySet<string>,
  matureKeys: ReadonlySet<string>,
): FuriganaPolicy {
  if (furigana === 'always') return ALWAYS;
  if (furigana === 'never') return NEVER;
  // Mature words by the first character of their written form, for the okurigana prefix rule.
  const byFirst = new Map<string, [written: string, kana: string][]>();
  for (const key of matureKeys) {
    const at = key.indexOf('|');
    if (at <= 0) continue;
    const written = key.slice(0, at);
    const first = [...written][0];
    byFirst.set(first, [...(byFirst.get(first) ?? []), [written, key.slice(at + 1)]]);
  }
  return {
    forRef(ref, hasKanji, isName) {
      if (isName) return true;
      if (!hasKanji) return false;
      return !(ref !== undefined && matureRefs.has(ref));
    },
    forRuby(base, reading) {
      if (matureKeys.has(`${base}|${reading}`)) return false;
      const first = [...base][0];
      const words = first === undefined ? undefined : byFirst.get(first);
      return !words?.some(([written, kana]) => written.startsWith(base) && kana.startsWith(reading));
    },
  };
}

/** pure: refs of word/core items whose read card is mature (stability ≥ 21 d). */
export function matureRefsFrom(cards: readonly Pick<CardRecord, 'itemId' | 'kind' | 'type' | 'stability' | 'suspended'>[]): string[] {
  return cards
    .filter((c) => c.type === 'read' && (c.kind === 'word' || c.kind === 'core') && !c.suspended && c.stability >= MATURE_STABILITY_DAYS)
    .map((c) => c.itemId)
    .sort();
}

/** pure: the `${written}|${kana}` keys of those refs. */
export function matureKeysFrom(refs: readonly string[], info: (ref: string) => Pick<WordInfo, 'written' | 'kana'> | undefined): Set<string> {
  const keys = new Set<string>();
  for (const ref of refs) {
    const word = info(ref);
    if (word) keys.add(`${word.written}|${word.kana}`);
  }
  return keys;
}

/** Refs of word/core items whose read card is mature, live. */
function useMatureRefs(): string[] {
  return useLiveQuery(
    async () => matureRefsFrom(await db.cards.where('type').equals('read').toArray()),
    [],
    [] as string[],
  );
}

function useWordInfo(): ((ref: string) => WordInfo | undefined) | null {
  const [info, setInfo] = useState<((ref: string) => WordInfo | undefined) | null>(null);
  useEffect(() => {
    let alive = true;
    loadWordInfo()
      .then((fn) => {
        if (alive) setInfo(() => fn);
      })
      .catch(() => {
        // Static data not available (offline before the first load): readings stay shown.
      });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** Live (read cards of word/core items with stability ≥ 21 d). Each partner's phone has its own cards, so the two see different furigana. */
export function useFuriganaPolicy(): FuriganaPolicy {
  const { furigana } = useSettings();
  const refs = useMatureRefs();
  const info = useWordInfo();
  return useMemo(
    () => furiganaPolicy(furigana, new Set(refs), info ? matureKeysFrom(refs, info) : new Set()),
    [furigana, refs, info],
  );
}

/** For <Ruby show>: (base, reading) => policy.forRuby(base, reading). */
export function useRubyShow(): 'all' | 'none' | ((base: string, reading?: string) => boolean) {
  const { furigana } = useSettings();
  const policy = useFuriganaPolicy();
  return useMemo(() => {
    if (furigana === 'always') return 'all';
    if (furigana === 'never') return 'none';
    return (base: string, reading?: string) => (reading === undefined ? true : policy.forRuby(base, reading));
  }, [furigana, policy]);
}

/** Deliberate cards and the first check: a reading only for words containing a kanji the learner has not been introduced to. */
export function useCardRubyShow(): (base: string, reading?: string) => boolean {
  const known = useKnownKanji();
  return useMemo(() => (base: string) => [...base].some((ch) => isKanji(ch) && !known.has(ch)), [known]);
}
