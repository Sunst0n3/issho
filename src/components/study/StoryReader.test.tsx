import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db.ts';
import type { PlayOptions, PlayResult } from '../../speech/audio.ts';
import { StudyDisplayContext } from './display.ts';
import { StoryReader, storyRate } from './StoryReader.tsx';
import { audioMock, KANA, resetStudyDb, STORIES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);

const STORY = STORIES[0];

function reader(step: 'rwl' | 'listen' | 'reread' | 'library', courseDay = 40) {
  const onDone = vi.fn();
  render(
    <StudyDisplayContext.Provider value={{ courseDay, inSprint: false, taught: new Set(), kana: KANA }}>
      <StoryReader story={STORY} step={step} onDone={onDone} />
    </StudyDisplayContext.Provider>,
  );
  return onDone;
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

  it('plays at full speed after course day 90 unless a rate is set', () => {
    expect(storyRate(undefined, 90)).toBe(0.85);
    expect(storyRate(undefined, 91)).toBe(1);
    expect(storyRate(1.1, 10)).toBe(1.1);
  });
});
