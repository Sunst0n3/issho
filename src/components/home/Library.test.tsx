import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WordInfo } from '../../lib/data.ts';
import { dayKey, db } from '../../lib/db.ts';
import type { ItemKind, StoryEntry, WordRef } from '../../lib/types.ts';
import Library from '../../screens/Library.tsx';
import { matchesWord, storyShelves } from './library.ts';
import { addLearned, renderAt, resetDb, STORIES } from './test-fixtures.tsx';

const mocks = vi.hoisted(() => ({ play: vi.fn(async () => ({ via: 'clip', ms: 300, interrupted: false })) }));

/** A story of 20 content words: the first `known` of them are the fixture words learned below. */
function storyOf(id: string, refs: WordRef[]): StoryEntry {
  return {
    id, level: 'L0', unit: 1, title: `Story ${id}`, titleJp: id, topic: 'daily', grammar: [], chars: 300, refs,
    gist: { q: '', options: [], answer: 0 },
    sentences: [{ jp: id, en: id, phrases: [id], tokens: refs.map((ref) => ({ s: ref, ref, k: 'c' as const })) }],
  };
}
const filler = (n: number): WordRef[] => Array.from({ length: n }, (_, i) => `word:filler-${i}` as WordRef);

vi.mock('../../lib/data.ts', async () => {
  const fixtures = await import('./test-fixtures.tsx');
  return {
    ...fixtures.dataMock,
    loadStories: async () => [
      ...fixtures.STORIES,
      // 19 of 20 known: 95 %, a stretch story.
      { ...fixtures.STORIES[1], id: 'st-stretch', title: 'Stretch story',
        sentences: [{ jp: 'x', en: 'x', phrases: ['x'], tokens: [...Array.from({ length: 19 }, (_, i) => ({ s: 'w', ref: `word:filler-${i}`, k: 'c' as const })), { s: 'u', ref: 'word:unknown', k: 'c' as const }] }] },
    ],
  };
});
vi.mock('../../speech/audio.ts', () => ({
  usePlayback: () => ({ play: mocks.play, stop: () => {}, playing: false }),
}));
vi.mock('../study/PitchLine.tsx', () => ({
  PitchLine: ({ accent }: { accent: { type: string } }) => <span data-testid="pitch">{accent.type}</span>,
}));

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function addWord(kind: ItemKind, key: string, introducedAt: Date, known = false) {
  const id = `${kind}:${key}`;
  await db.items.add({ id, kind, key, introducedAt });
  if (known) {
    await db.reviewLogs.add({
      cardId: `${id}|read`, itemId: id, kind, type: kind === 'core' ? 'listen' : 'read', grade: 3, reviewedAt: new Date(),
      durationMs: 3000, mode: 'typed', prevState: State.Review, elapsedDays: 3, context: 'review',
    });
  }
}

async function writeLog(char: string, at: Date) {
  await db.reviewLogs.add({
    cardId: `kanji:${char}|write`, itemId: `kanji:${char}`, kind: 'kanji', type: 'write', grade: 3, reviewedAt: at,
    durationMs: 9000, mode: 'written', prevState: State.Review, elapsedDays: 2, context: 'review',
  });
}

beforeEach(async () => {
  await resetDb();
  // 日: written well on three later days → can write. 一: learning, pinned. 水: retired → reading only.
  await addLearned('日', {}, { introducedAt: daysAgo(10) });
  for (const n of [8, 5, 1]) await writeLog('日', daysAgo(n));
  await addLearned('一', {}, { pinned: true });
  await addLearned('水', { suspended: 'retired' });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  document.documentElement.scrollTop = 0;
  vi.clearAllMocks();
});

const tileNames = (root: HTMLElement = document.body) =>
  within(root).queryAllByRole('link').map((a) => a.getAttribute('aria-label')).filter((n): n is string => Boolean(n?.includes(',')));

describe('Library: kanji', () => {
  it('groups kanji by chapter, opens the current one, and marks each tile', async () => {
    renderAt('/library', '/library', <Library />);
    // "Met": introduced. "Learned" means 3 spaced successes, which only 日 has ("can write").
    const chapter1 = await screen.findByRole('button', { name: 'Chapter 1, 3 of 8 kanji met' });
    expect(chapter1.getAttribute('aria-expanded')).toBe('true');
    const chapter2 = screen.getByRole('button', { name: /^Chapter 2/ });
    expect(chapter2.getAttribute('aria-expanded')).toBe('false');
    expect(tileNames()).toEqual([
      '日, day, can write',
      '一, one, learning, pinned',
      '水, water, reading only',
      '火, fire, next up',
      '木, tree, next up',
      '休, rest, next up',
      '金, gold, next up',
      '土, soil, next up',
    ]);
    expect(screen.getByRole('link', { name: '火, fire, next up' }).getAttribute('href')).toBe(`/kanji/${encodeURIComponent('火')}`);
    fireEvent.click(chapter2);
    expect(tileNames()).toContain('山, mountain, not met yet');
  });

  it('filters to the kanji met so far', async () => {
    renderAt('/library/kanji', '/library/:tab', <Library />);
    await screen.findByRole('button', { name: /^Chapter 1/ });
    expect(screen.getByText(/^3 kanji met so far, 1 you can write from memory/)).toBeTruthy();
    expect(screen.queryByText(/kanji learned so far/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Met' }));
    expect(tileNames()).toEqual(['日, day, can write', '一, one, learning, pinned', '水, water, reading only']);
  });

  it('comes back with the filter and the chapters it was left with', async () => {
    const first = renderAt('/library', '/library', <Library />);
    await screen.findByRole('button', { name: /^Chapter 1/ });
    fireEvent.click(screen.getByRole('button', { name: /^Chapter 2/ }));
    first.unmount();
    renderAt('/library', '/library', <Library />);
    expect((await screen.findByRole('button', { name: /^Chapter 2/ })).getAttribute('aria-expanded')).toBe('true');
  });

  it('restores the scroll position when coming back', async () => {
    sessionStorage.setItem('issho.library.view', JSON.stringify({ filter: 'all', open: {}, limits: {}, scrollY: 640 }));
    renderAt('/library', '/library', <Library />);
    await screen.findByRole('button', { name: /^Chapter 1/ });
    expect(document.documentElement.scrollTop).toBe(640);
  });

  it('has its sections as links, with grammar on its own page', async () => {
    renderAt('/library/kanji', '/library/:tab', <Library />);
    const nav = await screen.findByRole('navigation', { name: 'Library sections' });
    expect(within(nav).getByRole('link', { name: 'Kanji' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Words' }).getAttribute('href')).toBe('/library/words');
    expect(within(nav).getByRole('link', { name: 'Grammar' }).getAttribute('href')).toBe('/grammar');
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeTruthy();
  });
});

describe('Library: words', () => {
  beforeEach(async () => {
    await addWord('core', 'cw-0005', daysAgo(1));
    await addWord('word', 'w-hi', daysAgo(3));
    await addWord('core', 'cw-0004', daysAgo(5));
  });

  it('lists core and kanji words met so far, newest first, with audio and pitch lines', async () => {
    renderAt('/library/words', '/library/:tab', <Library />);
    expect(await screen.findByText('3 words met so far, newest first')).toBeTruthy();
    const list = screen.getByRole('list');
    const written = within(list).getAllByRole('listitem').map((li) => li.querySelector('.kd-word-written')?.textContent);
    expect(written).toEqual(['水', '日', 'コーヒー']);
    expect(within(list).getAllByTestId('pitch').map((p) => p.textContent)).toEqual(['heiban', 'atamadaka']);
    fireEvent.click(within(list).getByRole('button', { name: 'Listen to 水' }));
    // A word without a clip of its own still plays, from its text with the right reading.
    expect(mocks.play).toHaveBeenCalledWith({ ref: 'core:cw-0005' }, expect.objectContaining({ fallbackText: '{水|みず}' }));
  });

  it('searches in English and in kana', async () => {
    renderAt('/library/words', '/library/:tab', <Library />);
    const search = await screen.findByLabelText('Search your words');
    fireEvent.change(search, { target: { value: 'coffee' } });
    expect(await screen.findByText('1 word found')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'ひ' } });
    expect(await screen.findByText('1 word found')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByText('No word you know matches that.')).toBeTruthy();
  });
});

describe('Library: stories', () => {
  it('shelves stories as Easy, Stretch (with tap glosses) and Read, each linking to the reader', async () => {
    await addWord('core', 'cw-0004', daysAgo(20), true);
    for (let i = 0; i < 19; i++) await addWord('word', `filler-${i}`, daysAgo(20), true);
    await db.stories.put({ storyId: 'st-l1-03', stage: 1, firstDay: dayKey(daysAgo(2)), gist: [true], cpm: [] });
    renderAt('/library/stories', '/library/:tab', <Library />);

    const easy = await screen.findByRole('region', { name: 'Easy' });
    expect(within(easy).getByRole('link', { name: /Morning coffee/ }).getAttribute('href')).toBe('/read/st-start-01');
    const stretch = screen.getByRole('region', { name: 'Stretch' });
    expect(stretch.textContent).toContain('tap words for English');
    expect(within(stretch).getByRole('link', { name: /Stretch story/ }).getAttribute('href')).toBe('/read/st-stretch');
    const read = screen.getByRole('region', { name: 'Read' });
    expect(within(read).getByRole('link', { name: /The station/ }).textContent).toContain('in progress');
    expect(screen.getByText('1 more story opens up as you learn more words and grammar.')).toBeTruthy();
  });

  it('says when stories open up before any can be read', async () => {
    renderAt('/library/stories', '/library/:tab', <Library />);
    expect(await screen.findByText(/Stories open up once you know enough of their words and grammar/)).toBeTruthy();
  });
});

describe('library helpers', () => {
  it('shelves a started story as read, whatever its coverage', () => {
    const progress = new Map([['st-start-01', { storyId: 'st-start-01', stage: 2 as const, gist: [], cpm: [] }]]);
    const shelves = storyShelves(STORIES, () => true, progress, new Set());
    expect(shelves.read.map((v) => v.story.id)).toEqual(['st-start-01']);
    expect(shelves.easy.map((v) => v.story.id)).toEqual(['st-l0-02', 'st-l1-03']);
    expect(storyShelves([storyOf('x', filler(3))], () => false, new Map(), new Set()).later).toBe(1);
  });

  it('keeps unknown grammar off fresh ready shelves while preserving started stories', () => {
    const gated = { ...storyOf('gated', []), grammar: ['nai-form'] };
    const unseen = storyShelves([gated], () => true, new Map(), new Set());
    expect(unseen.easy).toEqual([]);
    expect(unseen.later).toBe(1);
    const ready = storyShelves([gated], () => true, new Map(), new Set(['nai-form']));
    expect(ready.easy.map((v) => v.story.id)).toEqual(['gated']);
    const progress = new Map([['gated', { storyId: 'gated', stage: 2 as const, gist: [], cpm: [] }]]);
    expect(storyShelves([gated], () => true, progress, new Set()).read.map((v) => v.story.id)).toEqual(['gated']);
  });

  it('matches words in either width and case', () => {
    const w: WordInfo = { ref: 'core:cw-0004', written: 'コーヒー', kana: 'コーヒー', en: 'Coffee', kanji: [], use: true, readings: ['コーヒー'] };
    expect(matchesWord(w, 'COFFEE')).toBe(true);
    expect(matchesWord(w, 'ｺｰﾋｰ')).toBe(true);
    expect(matchesWord(w, '')).toBe(true);
    expect(matchesWord(w, 'tea')).toBe(false);
  });
});

it('sends an unknown section back to the library', async () => {
  renderAt('/library/nope', '/library/:tab', <Library />);
  await waitFor(() => expect(screen.getByText('Other screen')).toBeTruthy());
});
