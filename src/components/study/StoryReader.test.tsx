import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db.ts';
import type { StoryEntry } from '../../lib/types.ts';
import type { PlayOptions, PlayResult } from '../../speech/audio.ts';
import { StudyDisplayContext } from './display.ts';
import { StoryReader, storyRate } from './StoryReader.tsx';
import { audioMock, KANA, resetStudyDb, STORIES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);

const STORY = STORIES[0];

function reader(step: 'rwl' | 'listen' | 'reread' | 'library', courseDay = 40, story: StoryEntry = STORY) {
  const onDone = vi.fn();
  render(
    <StudyDisplayContext.Provider value={{ courseDay, inSprint: false, taught: new Set(), kana: KANA }}>
      <StoryReader story={story} step={step} onDone={onDone} />
    </StudyDisplayContext.Provider>,
  );
  return onDone;
}

/** jsdom has no scrollIntoView: record which elements were scrolled to. */
function scrolls() {
  const calls: Element[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: function scrollIntoView(this: Element) { calls.push(this); },
  });
  return calls;
}

const current = () => [...document.querySelectorAll('.st-phrase.current')].map((e) => e.getAttribute('data-phrase'));

/** Clips that wait to be finished by the test; each call is recorded with its options. */
function heldClips() {
  const calls: { ref: string; opts: PlayOptions; finish: () => void }[] = [];
  audioMock.play.mockImplementation((source: unknown, opts?: unknown) => new Promise<PlayResult>((resolve) => {
    calls.push({ ref: (source as { ref: string }).ref, opts: (opts ?? {}) as PlayOptions, finish: () => resolve({ via: 'clip', ms: 1000, interrupted: false }) });
  }));
  return calls;
}

beforeEach(async () => {
  await resetStudyDb();
  audioMock.play.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('StoryReader', () => {
  it('reads while listening: each sentence’s clip plays at the slow rate and its phrases light up in order', async () => {
    const calls = heldClips();
    reader('rwl');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].ref).toBe('story:st-l0-01#0');
    expect(calls[0].opts.rate).toBe(0.85);
    expect(calls[0].opts.phrases).toEqual(STORY.sentences[0].phrases);
    expect(current()).toEqual(['0:0']);

    await act(async () => calls[0].finish());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].ref).toBe('story:st-l0-01#1');
    expect(current()).toEqual(['1:0']);
    act(() => calls[1].opts.onPhrase?.(1));
    expect(current()).toEqual(['1:1']);
    await act(async () => calls[1].finish());
    expect(current()).toEqual([]);
  });

  it('asks the gist question and records the step with the answer', async () => {
    heldClips();
    const onDone = reader('rwl');
    fireEvent.click(screen.getByRole('button', { name: 'I’ve finished' }));
    const grid = screen.getByRole('group', { name: 'Answer choices' });
    fireEvent.click(within(grid).getByRole('button', { name: /Water and a book/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ gistCorrect: true }));
    expect(await db.stories.get(STORY.id)).toMatchObject({ stage: 1, gist: [true] });
  });

  it('listen mode hides the text', async () => {
    heldClips();
    reader('listen');
    expect(screen.queryByText('日本')).toBeNull();
    expect(document.querySelector('.st-story')).toBeNull();
    expect(screen.getByText(/text stays hidden/)).toBeTruthy();
  });

  it('a timed re-read computes characters per minute and logs it', async () => {
    const now = vi.spyOn(performance, 'now');
    const onDone = reader('reread');
    expect(document.querySelector('.st-story')).toBeNull();
    now.mockReturnValue(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(document.querySelector('.st-story')).not.toBeNull();
    now.mockReturnValue(1000 + 30_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    // 13 characters in half a minute.
    expect(await screen.findByText('26 characters a minute')).toBeTruthy();
    await waitFor(async () => expect((await db.fluency.toArray()).map((r) => [r.kind, r.value, r.ref])).toEqual([['reread', 26, STORY.id]]));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith({ cpm: 26 });
  });

  it('library mode glosses a tapped word', async () => {
    reader('library');
    fireEvent.click(screen.getAllByRole('button', { name: /本/ })[0]);
    expect(await screen.findByText('Japan')).toBeTruthy();
  });

  it('library mode shows the English in the sticky footer, marks the tapped word, and puts it away on a second tap (V053)', async () => {
    reader('library');
    const word = screen.getAllByRole('button', { name: /日本/ })[0];
    expect(word.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(word);
    const english = await screen.findByText('Japan');
    // In the footer (position: sticky at the bottom), not after the whole story.
    expect(english.closest('.st-footer')).not.toBeNull();
    expect(english.closest('[role="status"]')).not.toBeNull();
    expect(word.getAttribute('aria-pressed')).toBe('true');
    expect(word.classList.contains('selected')).toBe(true);
    // Only the tapped occurrence is marked.
    expect(document.querySelectorAll('.st-token.selected')).toHaveLength(1);
    fireEvent.click(word);
    expect(screen.queryByText('Japan')).toBeNull();
    expect(word.getAttribute('aria-pressed')).toBe('false');
  });

  it('library mode glosses an inflected word by its dictionary form (V067)', async () => {
    const story: StoryEntry = {
      ...STORY,
      sentences: [{ jp: '{食|た}べた。', en: 'I ate.', phrases: ['{食|た}べた。'], tokens: [
        { s: '食べ', r: 'たべ', k: 'c', ref: 'core:cw-0002', ph: 0 }, { s: 'た', k: 'f', ph: 0 }, { s: '。', k: 'p', ph: 0 },
      ] }],
    };
    reader('library', 40, story);
    fireEvent.click(screen.getByRole('button', { name: /食べ/ }));
    expect(await screen.findByText('to eat')).toBeTruthy();
    const card = document.querySelector('.st-gloss')!;
    expect(card.querySelector('.st-word-written')?.textContent).toBe('食べる');
    expect(card.querySelector('.st-word-kana')?.textContent).toBe('たべる');
  });

  it('library mode lines are tall enough for 44 px word buttons (V089)', () => {
    reader('library');
    expect(document.querySelector('.st-story')?.classList.contains('tappable')).toBe(true);
    // jsdom has no layout: the rules behind it are checked instead (vitest runs from the project root).
    const css = readFileSync(join(process.cwd(), 'src/components/study/study.css'), 'utf8');
    expect(css).toMatch(/\.st-story\.tappable \.st-story-sentence \{ line-height: max\(2em, 44px\); \}/);
    expect(css).toMatch(/\.st-token \{[^}]*min-height: 44px/);
  });

  it('a timed re-read compares with the best earlier re-read of any story (V055)', async () => {
    await db.fluency.add({ kind: 'reread', day: '2026-10-01', at: new Date(Date.now() - 86_400_000), value: 180, ref: 'st-start-03' });
    const now = vi.spyOn(performance, 'now');
    reader('reread');
    now.mockReturnValue(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    now.mockReturnValue(1000 + 30_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('26 characters a minute')).toBeTruthy();
    expect(await screen.findByText('Your best: 180')).toBeTruthy();
    expect(screen.queryByText('Your best yet')).toBeNull();
  });

  it('a timed re-read faster than every earlier one is the best yet', async () => {
    await db.fluency.add({ kind: 'reread', day: '2026-10-01', at: new Date(Date.now() - 86_400_000), value: 20, ref: 'st-start-03' });
    const now = vi.spyOn(performance, 'now');
    reader('reread');
    now.mockReturnValue(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    now.mockReturnValue(1000 + 30_000);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Your best yet')).toBeTruthy();
  });

  it('keeps the phrase being read in view, then brings the question into view with focus (V057)', async () => {
    const scrolled = scrolls();
    const calls = heldClips();
    reader('rwl');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].finish());
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => calls[1].opts.onPhrase?.(1));
    expect(scrolled.map((e) => e.getAttribute('data-phrase'))).toEqual(['0:0', '1:0', '1:1']);

    fireEvent.click(screen.getByRole('button', { name: 'I’ve finished' }));
    const heading = screen.getByRole('heading', { name: 'What is the story about?' });
    expect(document.activeElement).toBe(heading);
    expect(scrolled.at(-1)).toBe(heading.closest('section'));

    // The Done footer that follows the answer would cover the last options: the question comes back into view.
    const before = scrolled.length;
    fireEvent.click(within(screen.getByRole('group', { name: 'Answer choices' })).getByRole('button', { name: /Water and a book/ }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(scrolled.slice(before)).toEqual([heading.closest('section')]);
  });

  it('clears the highlight when listening stops for the question, but keeps it on pause (V066)', async () => {
    const calls = heldClips();
    reader('rwl');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(current()).toEqual(['0:0']);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I’ve finished' }));
    expect(current()).toEqual([]);
    expect(screen.getByRole('heading', { name: 'What is the story about?' })).toBeTruthy();
  });

  it('plays at full speed after course day 90 unless a rate is set', () => {
    expect(storyRate(undefined, 90)).toBe(0.85);
    expect(storyRate(undefined, 91)).toBe(1);
    expect(storyRate(1.1, 10)).toBe(1.1);
  });
});
