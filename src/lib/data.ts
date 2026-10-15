// Loads the static study data from public/data and public/audio/manifest.json (precached by the
// service worker, so this works offline). Every loader is memoized for the life of the page.
// Optional content (stories, units, role-plays, accent, audio) loads as empty when not built yet.

import type {
  AccentFile,
  AudioManifest,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  MnemonicsFile,
  RadicalEntry,
  Register,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  StrokesFile,
  UnitSpec,
  WordEntry,
  WordRef,
} from './types.ts';

const BASE = `${import.meta.env.BASE_URL}data/`;
const AUDIO_BASE = `${import.meta.env.BASE_URL}audio/`;

/** A short word on a kana's learn card (content/kana-examples.json); its clip ref is 'kanaEx:<char>'. */
export interface KanaExample {
  kana: string;
  written?: string;
  en: string;
  /** Basic kana: one-line picture mnemonic (≤ 12 words), shown in KanaLesson and after a kana-write miss. */
  hook?: string;
}

/** content/kana-examples.json: one example per basic, dakuten and handakuten kana, keyed by the kana. */
export type KanaExamplesFile = Record<string, KanaExample>;

export const EMPTY_MANIFEST: AudioManifest = {
  version: 1,
  generatedAt: '',
  engine: '',
  credits: [],
  clips: {},
  byRef: {},
  byText: {},
};

const cache = new Map<string, Promise<unknown>>();

function memo<T>(url: string, fetcher: () => Promise<T>): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetcher();
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

function load<T>(url: string): Promise<T> {
  return memo(url, () =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
      return r.json() as Promise<T>;
    }),
  );
}

/** Like load, but a file that is not there (404, or an HTML fallback page) is `empty`. */
function loadOptional<T>(url: string, empty: T): Promise<T> {
  return memo(url, () =>
    fetch(url).then((r) => {
      const json = (r.headers.get('content-type') ?? '').includes('json');
      if (r.status === 404 || (r.ok && !json)) {
        console.warn(`${url} is not built yet`);
        return empty;
      }
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
      return r.json() as Promise<T>;
    }),
  );
}

export const loadKana = () => load<KanaEntry[]>(`${BASE}kana.json`);
export const loadKanji = () => load<Record<string, KanjiEntry>>(`${BASE}kanji.json`);
export const loadRadicals = () => load<RadicalEntry[]>(`${BASE}radicals.json`);
export const loadWords = () => load<WordEntry[]>(`${BASE}words.json`);
export const loadCurriculum = () => load<Curriculum>(`${BASE}curriculum.json`);
export const loadStrokes = () => load<StrokesFile>(`${BASE}strokes.json`);
export const loadAccent = () => loadOptional<AccentFile>(`${BASE}accent.json`, {});
export const loadCoreWords = () => load<CoreWord[]>(`${BASE}content/core-words.json`);
export const loadKanaRules = () => load<KanaRule[]>(`${BASE}content/kana-rules.json`);
export const loadKanaExamples = () => load<KanaExamplesFile>(`${BASE}content/kana-examples.json`);
export const loadMnemonics = () => load<MnemonicsFile>(`${BASE}content/mnemonics.json`);
export const loadGrammar = () => load<GrammarPoint[]>(`${BASE}content/grammar.json`);
export const loadSentences = () => load<SentenceEntry[]>(`${BASE}content/sentences.json`);
export const loadStories = () => loadOptional<StoryEntry[]>(`${BASE}content/stories.json`, []);
export const loadRolePlays = () => loadOptional<RolePlay[]>(`${BASE}content/roleplays.json`, []);
export const loadUnits = () => loadOptional<UnitSpec[]>(`${BASE}content/units.json`, []);
export const loadAudioManifest = () => loadOptional<AudioManifest>(`${AUDIO_BASE}manifest.json`, EMPTY_MANIFEST);

/** URL of a clip file from the manifest ('a3/a3f0….m4a'). */
export function audioUrl(file: string): string {
  return AUDIO_BASE + file;
}

let wordIndex: Promise<Map<string, WordEntry>> | undefined;
/** JMdict words by id. */
export function loadWordIndex(): Promise<Map<string, WordEntry>> {
  wordIndex ??= loadWords().then((ws) => new Map(ws.map((w) => [w.id, w])));
  wordIndex.catch(() => (wordIndex = undefined));
  return wordIndex;
}

let coreIndex: Promise<Map<string, CoreWord>> | undefined;
/** Core words by id. */
export function loadCoreIndex(): Promise<Map<string, CoreWord>> {
  coreIndex ??= loadCoreWords().then((ws) => new Map(ws.map((w) => [w.id, w])));
  coreIndex.catch(() => (coreIndex = undefined));
  return coreIndex;
}

let grammarIndex: Promise<Map<string, GrammarPoint>> | undefined;
/** Grammar points by id. */
export function loadGrammarIndex(): Promise<Map<string, GrammarPoint>> {
  grammarIndex ??= loadGrammar().then((gs) => new Map(gs.map((g) => [g.id, g])));
  grammarIndex.catch(() => (grammarIndex = undefined));
  return grammarIndex;
}

/** One word as every screen shows it, whether it is a core word or a JMdict word. */
export interface WordInfo {
  ref: WordRef;
  /** Usual written form: the kanji spelling when there is one, else the kana. */
  written: string;
  kana: string;
  en: string;
  kanji: string[];
  /** The learner should produce it (produce card). */
  use: boolean;
  /** Accepted typed readings: kana first, then alternates. */
  readings: string[];
  register?: Register;
  note?: string;
  core?: CoreWord;
  entry?: WordEntry;
}

let wordInfo: Promise<(ref: string) => WordInfo | undefined> | undefined;
/** Resolves 'core:<id>' and 'word:<id>' refs. */
export function loadWordInfo(): Promise<(ref: string) => WordInfo | undefined> {
  wordInfo ??= Promise.all([loadCoreIndex(), loadWordIndex()]).then(([cores, words]) => {
    const infos = new Map<string, WordInfo>();
    for (const c of cores.values()) {
      infos.set(`core:${c.id}`, {
        ref: `core:${c.id}`,
        written: c.written ?? c.kana,
        kana: c.kana,
        en: c.en,
        kanji: c.kanji,
        use: c.use,
        readings: [c.kana, ...(c.altKana ?? [])],
        register: c.register,
        note: c.note,
        core: c,
      });
    }
    for (const w of words.values()) {
      infos.set(`word:${w.id}`, {
        ref: `word:${w.id}`,
        written: w.written,
        kana: w.kana,
        en: w.meanings.join('; '),
        kanji: w.kanji,
        use: w.use ?? false,
        readings: [w.kana, ...(w.altKana ?? [])],
        entry: w,
      });
    }
    return (ref: string) => infos.get(ref);
  });
  wordInfo.catch(() => (wordInfo = undefined));
  return wordInfo;
}

/** Stroke paths for one character, or undefined when KanjiVG has none. */
export async function strokesFor(char: string): Promise<string[] | undefined> {
  return (await loadStrokes())[char];
}

/** Tests: forget every memoized load and index. */
export function clearDataCache(): void {
  cache.clear();
  wordIndex = undefined;
  coreIndex = undefined;
  grammarIndex = undefined;
  wordInfo = undefined;
}
