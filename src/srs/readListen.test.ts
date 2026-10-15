import { Rating } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dayKey, db } from '../lib/db.ts';
import type { PreToken, SentenceEntry, StoryEntry, StoryProgressRecord, WordRef } from '../lib/types.ts';
import { addDays, emptyDay } from './days.ts';
import { encounterCounts } from './encounters.ts';
import { introduceItem } from './items.ts';
import {
  coverage,
  exampleSentenceFor,
  knownWordsFrom,
  loadKnownWords,
  markSentencesShown,
  pickIPlusOne,
  pickRead,
  pickStory,
  recordStoryStep,
  resetReadingMemory,
  storyCoverage,
  stretchStories,
  type IPlusOneContext,
} from './readListen.ts';
import { gradeCard } from './scheduler.ts';
import { at, fixtures, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const TODAY = '2026-03-20';
const tok = (ref: string, extra: Partial<PreToken> = {}): PreToken => ({ s: ref, ref: ref as WordRef, k: 'c', ...extra });
const fn = (s: string): PreToken => ({ s, k: 'f' });

function sentence(id: string, refs: string[], grammar: string[] = []): SentenceEntry {
  return {
    id, jp: id, en: id, grammar, unit: 1, refs: refs as WordRef[],
    tokens: refs.flatMap((r) => [tok(r), fn('は')]),
  };
}

/** Words introduced `age` days before TODAY; `known` ones also passed a read. */
function ctxWith(words: Record<string, { age: number; known?: boolean }>, patch: Partial<IPlusOneContext> = {}): IPlusOneContext {
  const introduced = new Map(Object.entries(words).map(([ref, w]) => [ref, addDays(TODAY, -w.age)]));
  const known = new Set(Object.entries(words).filter(([, w]) => w.known).map(([ref]) => ref));
  return { known: knownWordsFrom(introduced, known), grammarKnown: new Set(['wa-desu']), today: TODAY, encounters: new Map(), resting: new Set(), ...patch };
}

describe('pickIPlusOne', () => {
  const words = {
    'word:old': { age: 30, known: true },
    'word:new1': { age: 1 },
    'word:new21': { age: 21 },
    'word:new0': { age: 0 },
    'word:new22': { age: 22 },
    'word:fresh': { age: 3 },
    'word:fresh2': { age: 4 },
  };

  it('picks a sentence with exactly one new word, introduced 1–21 days ago', () => {
    const ctx = ctxWith(words);
    expect(pickIPlusOne([sentence('a', ['word:old', 'word:new1'])], ctx, 3)).toEqual([{ id: 'a', target: 'word:new1' }]);
    expect(pickIPlusOne([sentence('b', ['word:old', 'word:new21'])], ctx, 3)).toEqual([{ id: 'b', target: 'word:new21' }]);
    expect(pickIPlusOne([sentence('c', ['word:old', 'word:new0'])], ctx, 3)).toEqual([]);
    expect(pickIPlusOne([sentence('d', ['word:old', 'word:new22'])], ctx, 3)).toEqual([]);
  });

  it('never picks two unknown words, an untaught grammar tag, a resting sentence or an unlinked token', () => {
    const ctx = ctxWith(words, { resting: new Set(['rest']) });
    expect(pickIPlusOne([sentence('two', ['word:fresh', 'word:fresh2'])], ctx, 3)).toEqual([]);
    expect(pickIPlusOne([sentence('gram', ['word:old', 'word:fresh'], ['passive'])], ctx, 3)).toEqual([]);
    expect(pickIPlusOne([sentence('rest', ['word:old', 'word:fresh'])], ctx, 3)).toEqual([]);
    const unlinked = sentence('nolink', ['word:old', 'word:fresh']);
    unlinked.tokens.push({ s: '何か', k: 'c' });
    expect(pickIPlusOne([unlinked], ctx, 3)).toEqual([]);
    const named = sentence('named', ['word:old', 'word:fresh']);
    named.tokens.push({ s: '田中', k: 'c', name: true });
    expect(pickIPlusOne([named], ctx, 3)).toHaveLength(1);
  });

  it('prefers encounter-starved targets and keeps targets distinct', () => {
    const ctx = ctxWith(words, { encounters: new Map([['word:fresh', 9], ['word:fresh2', 2]]) });
    const picks = pickIPlusOne(
      [sentence('s1', ['word:old', 'word:fresh']), sentence('s2', ['word:old', 'word:fresh2']), sentence('s3', ['word:fresh2'])],
      ctx,
      3,
    );
    expect(picks).toEqual([{ id: 's2', target: 'word:fresh2' }, { id: 's1', target: 'word:fresh' }]);
  });
});

describe('coverage', () => {
  it('counts content tokens with a known ref, leaving names out', () => {
    const tokens: PreToken[] = [
      ...Array.from({ length: 49 }, () => tok('word:k')),
      tok('word:u'),
      ...Array.from({ length: 3 }, () => ({ s: '田中', k: 'c' as const, name: true as const })),
      fn('は'),
      { s: '。', k: 'p' },
    ];
    const isKnown = (ref: string) => ref === 'word:k';
    expect(coverage(tokens, isKnown)).toEqual({ content: 50, known: 49, ratio: 0.98 });
    expect(coverage([fn('は')], isKnown).ratio).toBe(1);
  });
});

function story(id: string, known: number, total: number, extra: Partial<StoryEntry> = {}): StoryEntry {
  const tokens = Array.from({ length: total }, (_, i) => tok(i < known ? 'word:k' : `word:u${i}`));
  return {
    id, level: 'L0', unit: 3, title: id, titleJp: id, topic: '', grammar: [], gist: { q: '', options: [], answer: 0 }, chars: 100, refs: ['word:k'],
    sentences: [{ jp: id, en: id, tokens, phrases: [id] }],
    ...extra,
  };
}

describe('stories', () => {
  const isKnown = (ref: string) => ref === 'word:k';

  it('never picks a story below 98 % for a first read', () => {
    expect(storyCoverage(story('low', 979, 1000), isKnown)).toBe(0.979);
    expect(pickStory([story('low', 979, 1000)], { isKnown, progress: new Map(), today: TODAY })).toBeNull();
    expect(pickStory([story('ok', 98, 100)], { isKnown, progress: new Map(), today: TODAY })).toEqual({ storyId: 'ok', step: 'rwl', shared: false });
  });

  it('prefers a due listen step, then the shared story, then level order', () => {
    const stories = [story('a', 100, 100, { level: 'start' }), story('b', 100, 100), story('shared', 100, 100, { level: 'L1' })];
    const listenDue: StoryProgressRecord = { storyId: 'b', stage: 1, firstDay: addDays(TODAY, -3), nextDay: TODAY, gist: [true], cpm: [] };
    expect(pickStory(stories, { isKnown, progress: new Map([['b', listenDue]]), today: TODAY, sharedStoryId: 'shared' }))
      .toEqual({ storyId: 'b', step: 'listen', shared: false });
    expect(pickStory(stories, { isKnown, progress: new Map(), today: TODAY, sharedStoryId: 'shared' }))
      .toEqual({ storyId: 'shared', step: 'rwl', shared: true });
    expect(pickStory(stories, { isKnown, progress: new Map(), today: TODAY })).toEqual({ storyId: 'a', step: 'rwl', shared: false });
  });

  it('offers stretch stories between 95 % and 98 %', () => {
    const list = [story('easy', 98, 100), story('stretch', 96, 100), story('edge', 95, 100), story('hard', 94, 100)];
    expect(stretchStories(list, isKnown).map((s) => s.id)).toEqual(['stretch', 'edge']);
  });

  it('climbs the ladder: listen 3 days after the first read, re-read 10 days after it', async () => {
    fixtures.stories = [story('st', 100, 100)];
    const day0 = at(2026, 3, 1, 9);
    await recordStoryStep('st', 'rwl', { gistCorrect: true }, day0);
    expect(await db.stories.get('st')).toMatchObject({ stage: 1, firstDay: '2026-03-01', nextDay: '2026-03-04', gist: [true] });
    await recordStoryStep('st', 'rwl', { gistCorrect: false }, day0);
    expect((await db.stories.get('st'))?.gist).toEqual([true]);
    await recordStoryStep('st', 'listen', {}, at(2026, 3, 5, 9));
    expect(await db.stories.get('st')).toMatchObject({ stage: 2, nextDay: '2026-03-11' });
    await recordStoryStep('st', 'reread', { cpm: 240 }, at(2026, 3, 12, 9));
    const done = await db.stories.get('st');
    expect(done).toMatchObject({ stage: 3, cpm: [240] });
    expect(done?.nextDay).toBeUndefined();
  });

  it('logs story encounters for introduced words', async () => {
    fixtures.stories = [story('st', 100, 100)];
    await introduceItem('word', 'k', at(2026, 2, 1));
    await recordStoryStep('st', 'rwl', {}, at(2026, 3, 1, 9));
    expect((await encounterCounts(['word:k'], at(2026, 3, 1, 9))).get('word:k')).toBe(1);
  });
});

describe('pickRead', () => {
  const NOW = at(2026, 3, 20, 9);

  async function setup(storyMs: number) {
    await db.days.bulkPut(Array.from({ length: 70 }, (_, i) => ({ ...emptyDay(addDays(TODAY, -(i + 1))), reviews: 1 })));
    await introduceItem('word', 'k', at(2026, 1, 1), {});
    await gradeCard('word:k|read', Rating.Good, { durationMs: 1000, mode: 'typed', now: at(2026, 1, 2) });
    for (const id of ['n1', 'n2', 'n3']) await introduceItem('word', id, at(2026, 3, 15), {});
    fixtures.sentences = ['n1', 'n2', 'n3'].map((id) => sentence(`s-${id}`, ['word:k', `word:${id}`]));
    fixtures.stories = [story('st', 100, 100)];
    fixtures.manifest = {
      ...fixtures.manifest,
      clips: { c1: { file: 'x.m4a', ms: storyMs, voice: 'f', pack: 'u03', via: 'text' } },
      byRef: { 'story:st#0': 'c1' },
    };
  }

  it('plans a story only when its estimate fits, never more than the minutes', async () => {
    await setup(30_000); // 30 s → 30 / 1 / 60 + 1 = 1.5 → 2 min (at least 2)
    const plan = await pickRead({ minutes: 3 }, NOW);
    expect(plan.kind).toBe('story');
    expect(plan.story).toEqual({ storyId: 'st', step: 'rwl', shared: false });
    expect(plan.sentences).toHaveLength(1);
    expect(plan.minutes).toBe(3);
  });

  it('falls back to sentences when the story does not fit', async () => {
    await setup(150_000); // 2.5 min of audio + 1 → 3.5 min
    const plan = await pickRead({ minutes: 3 }, NOW);
    expect(plan.kind).toBe('sentences');
    expect(plan.story).toBeUndefined();
    expect(plan.sentences).toHaveLength(3);
    expect(plan.minutes).toBeLessThanOrEqual(3);
    const one = await pickRead({ minutes: 1 }, NOW);
    expect(one.sentences).toHaveLength(1);
  });

  it('skips sentences shown in the last 7 days', async () => {
    await setup(150_000);
    await markSentencesShown(['s-n1', 's-n2'], at(2026, 3, 15, 9));
    await markSentencesShown(['s-n1', 's-n2'], at(2026, 3, 15, 10));
    expect((await db.shownSentences.get('s-n1'))?.count).toBe(1);
    expect((await pickRead({ minutes: 3 }, NOW)).sentences.map((s) => s.id)).toEqual(['s-n3']);
    await resetReadingMemory();
    expect((await pickRead({ minutes: 3 }, NOW)).sentences).toHaveLength(3);
  });
});

describe('known words', () => {
  it('knows a word once its read or listen card passed', async () => {
    const now = at(2026, 3, 20, 9);
    await introduceItem('word', '1002', at(2026, 3, 1));
    await introduceItem('core', 'cw-0001', at(2026, 3, 1));
    await introduceItem('word', '1004', at(2026, 3, 1));
    await gradeCard('word:1002|read', Rating.Good, { durationMs: 1, mode: 'typed', now: at(2026, 3, 2) });
    await gradeCard('core:cw-0001|listen', Rating.Hard, { durationMs: 1, mode: 'self', now: at(2026, 3, 2) });
    await gradeCard('word:1004|read', Rating.Again, { durationMs: 1, mode: 'typed', now: at(2026, 3, 2) });
    const known = await loadKnownWords(now);
    expect(known.isKnown('word:1002')).toBe(true);
    expect(known.isKnown('core:cw-0001')).toBe(true);
    expect(known.isKnown('word:1004')).toBe(false);
    expect(known.introducedDay('word:1004')).toBe(dayKey(at(2026, 3, 1)));
    expect(known.introducedDay('word:9')).toBeUndefined();

    const carrier = sentence('carrier', ['word:1002', 'core:cw-0001']);
    expect(exampleSentenceFor('word:1002', [sentence('x', ['word:1002', 'word:1004']), carrier], known)?.id).toBe('carrier');
  });
});
