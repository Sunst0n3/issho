// Loads the static study data from public/data (precached by the service worker,
// so this works offline). Every loader is memoized for the life of the page.

import type {
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanjiEntry,
  MnemonicsFile,
  RadicalEntry,
  RolePlay,
  SentenceEntry,
  StrokesFile,
  SurvivalWord,
  WordEntry,
} from './types.ts';

const BASE = `${import.meta.env.BASE_URL}data/`;

const cache = new Map<string, Promise<unknown>>();

function load<T>(file: string): Promise<T> {
  let p = cache.get(file) as Promise<T> | undefined;
  if (!p) {
    p = fetch(BASE + file).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${file} (${r.status})`);
      return r.json() as Promise<T>;
    });
    p.catch(() => cache.delete(file));
    cache.set(file, p);
  }
  return p;
}

export const loadKana = () => load<KanaEntry[]>('kana.json');
export const loadKanji = () => load<Record<string, KanjiEntry>>('kanji.json');
export const loadRadicals = () => load<RadicalEntry[]>('radicals.json');
export const loadWords = () => load<WordEntry[]>('words.json');
export const loadCurriculum = () => load<Curriculum>('curriculum.json');
export const loadStrokes = () => load<StrokesFile>('strokes.json');
export const loadMnemonics = () => load<MnemonicsFile>('content/mnemonics.json');
export const loadSurvivalWords = () => load<SurvivalWord[]>('content/survival-words.json');
export const loadGrammar = () => load<GrammarPoint[]>('content/grammar.json');
export const loadSentences = () => load<SentenceEntry[]>('content/sentences.json');
export const loadRolePlays = () => load<RolePlay[]>('content/roleplays.json');

let wordIndex: Promise<Map<string, WordEntry>> | undefined;
export function loadWordIndex(): Promise<Map<string, WordEntry>> {
  wordIndex ??= loadWords().then((ws) => new Map(ws.map((w) => [w.id, w])));
  return wordIndex;
}

/** Stroke paths for one character, or undefined when KanjiVG has none. */
export async function strokesFor(char: string): Promise<string[] | undefined> {
  return (await loadStrokes())[char];
}
