// Data for the library and the kanji pages: curriculum kanji with the learner's state for each,
// the words they've met, and the stories they can read.
import Dexie from 'dexie';
import { loadCurriculum, loadKanji, loadStories, loadWordInfo, type WordInfo } from '../../lib/data.ts';
import { dayKey, db, itemId } from '../../lib/db.ts';
import type { CardRecord, Curriculum, CurriculumUnit, ItemRecord, KanjiEntry, ReviewLogRecord, StoryEntry, StoryProgressRecord } from '../../lib/types.ts';
import { isLearned } from '../../srs/progress.ts';
import { EASY_COVERAGE, loadKnownWords, storyCoverage, stretchStories } from '../../srs/readListen.ts';

/** How many upcoming kanji are marked "next up". */
export const NEXT_UP = 5;

/**
 * canWrite: the write card passed 3 spaced reviews. learning: introduced, not yet there.
 * readingOnly: past the handwriting list and solid, so its write card retired (reading continues).
 * next: among the next few in the course. locked: later.
 */
export type KanjiState = 'canWrite' | 'learning' | 'readingOnly' | 'next' | 'locked';

export interface KanjiTileView {
  unit: CurriculumUnit;
  meaning: string;
  state: KanjiState;
  /** Kept in handwriting beyond the list. */
  pinned: boolean;
}

export interface KanjiProgress {
  items: ReadonlyMap<string, ItemRecord>;
  /** kanji item id → its write card. */
  writeCards: ReadonlyMap<string, CardRecord>;
  /** kanji item ids whose write card is learned. */
  canWrite: ReadonlySet<string>;
}

/** pure */
export function kanjiViews(curriculum: Curriculum, kanji: Record<string, KanjiEntry>, p: KanjiProgress): KanjiTileView[] {
  let nextLeft = NEXT_UP;
  return [...curriculum.units].sort((a, b) => a.index - b.index).map((unit) => {
    const id = itemId('kanji', unit.char);
    const item = p.items.get(id);
    let state: KanjiState = 'locked';
    if (item) {
      if (p.writeCards.get(id)?.suspended === 'retired') state = 'readingOnly';
      else state = p.canWrite.has(id) ? 'canWrite' : 'learning';
    } else if (nextLeft > 0) {
      state = 'next';
      nextLeft--;
    }
    return { unit, meaning: kanji[unit.char]?.meanings[0] ?? '', state, pinned: Boolean(item?.pinned) };
  });
}

/** Write logs of kanji, grouped by item. */
async function kanjiWriteLogs(): Promise<Map<string, ReviewLogRecord[]>> {
  const logs = await db.reviewLogs
    .where('[type+reviewedAt]')
    .between(['write', Dexie.minKey], ['write', Dexie.maxKey])
    .toArray();
  const byItem = new Map<string, ReviewLogRecord[]>();
  for (const log of logs) {
    if (log.kind !== 'kanji') continue;
    const list = byItem.get(log.itemId) ?? [];
    list.push(log);
    byItem.set(log.itemId, list);
  }
  return byItem;
}

export async function loadKanjiProgress(): Promise<KanjiProgress> {
  const [items, cards, logs] = await Promise.all([
    db.items.where('kind').equals('kanji').toArray(),
    db.cards.where('itemId').startsWith('kanji:').toArray(),
    kanjiWriteLogs(),
  ]);
  const writeCards = new Map(cards.filter((c) => c.type === 'write').map((c) => [c.itemId, c]));
  const canWrite = new Set<string>();
  for (const item of items) {
    const itemLogs = logs.get(item.id);
    if (itemLogs && isLearned(itemLogs, dayKey(item.introducedAt))) canWrite.add(item.id);
  }
  return { items: new Map(items.map((i) => [i.id, i])), writeCards, canWrite };
}

/** Everything the kanji tab shows, read live from the database. */
export async function loadKanjiLibrary(): Promise<KanjiTileView[]> {
  const [curriculum, kanji, progress] = await Promise.all([loadCurriculum(), loadKanji(), loadKanjiProgress()]);
  return kanjiViews(curriculum, kanji, progress);
}

// ---- Words ----

export interface WordView {
  info: WordInfo;
  introducedAt: Date;
}

/** Core and kanji words the learner has met, newest first. */
export async function loadWordLibrary(): Promise<WordView[]> {
  const [items, info] = await Promise.all([db.items.where('kind').anyOf('core', 'word').toArray(), loadWordInfo()]);
  return items
    .flatMap((item) => {
      const w = info(item.id);
      return w ? [{ info: w, introducedAt: item.introducedAt }] : [];
    })
    .sort((a, b) => b.introducedAt.getTime() - a.introducedAt.getTime());
}

/**
 * The word as the audio generator wrote it: `{written|kana}`, or the kana for a kana-only word. Played
 * when the word has no clip of its own (words outside the generated scope), it still finds a clip by text
 * or goes to the server or device voice with the right reading.
 */
export function wordSpeechText(w: Pick<WordInfo, 'written' | 'kana'>): string {
  return w.written !== w.kana ? `{${w.written}|${w.kana}}` : w.kana;
}

/** Case- and width-insensitive match on the written form, the kana or the English. */
export function matchesWord(w: WordInfo, query: string): boolean {
  const q = query.normalize('NFKC').trim().toLowerCase();
  if (!q) return true;
  return [w.written, w.kana, ...w.readings, w.en].some((s) => s.normalize('NFKC').toLowerCase().includes(q));
}

// ---- Stories ----

export interface StoryView {
  story: StoryEntry;
  coverage: number;
  progress?: StoryProgressRecord;
}

export interface StoryShelves {
  /** ≥ 98 % known, not started. */
  easy: StoryView[];
  /** 95–98 %: read with tap glosses. */
  stretch: StoryView[];
  /** Started or finished. */
  read: StoryView[];
  /** Stories still out of reach. */
  later: number;
}

/** pure */
export function storyShelves(stories: readonly StoryEntry[], isKnown: (ref: string) => boolean, progress: ReadonlyMap<string, StoryProgressRecord>): StoryShelves {
  const stretchIds = new Set(stretchStories(stories, isKnown).map((s) => s.id));
  const shelves: StoryShelves = { easy: [], stretch: [], read: [], later: 0 };
  for (const story of stories) {
    const view: StoryView = { story, coverage: storyCoverage(story, isKnown), progress: progress.get(story.id) };
    if (view.progress && view.progress.stage > 0) shelves.read.push(view);
    else if (view.coverage >= EASY_COVERAGE) shelves.easy.push(view);
    else if (stretchIds.has(story.id)) shelves.stretch.push(view);
    else shelves.later++;
  }
  return shelves;
}

export async function loadStoryShelves(): Promise<StoryShelves> {
  const [stories, known, progress] = await Promise.all([loadStories(), loadKnownWords(), db.stories.toArray()]);
  return storyShelves(stories, (ref) => known.isKnown(ref), new Map(progress.map((p) => [p.storyId, p])));
}
