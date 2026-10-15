import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dayKey, updateSettings } from '../../lib/db.ts';
import GrammarDetail from '../../screens/GrammarDetail.tsx';
import GrammarList, { byUnit } from '../../screens/GrammarList.tsx';
import Reading from '../../screens/Reading.tsx';
import WritePractice, { markTried, triedToday } from '../../screens/WritePractice.tsx';
import { introduceItem } from '../../srs/items.ts';
import { saveSentence } from './sentences.ts';
import { audioMock, GRAMMAR, resetStudyDb, SENTENCES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);
vi.mock('../../speech/recorder.ts', () => ({ micAvailable: () => false }));

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={['/', path]} initialIndex={1} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<p>Today screen</p>} />
        <Route path="/write/:char" element={<WritePractice />} />
        <Route path="/grammar" element={<GrammarList />} />
        <Route path="/grammar/:id" element={<GrammarDetail />} />
        <Route path="/read" element={<Reading />} />
        <Route path="/read/:storyId" element={<Reading />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await resetStudyDb({ knowsHiragana: true, knowsKatakana: true });
  audioMock.play.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('WritePractice', () => {
  it('gives a kanji introduced before today one ungraded recall a day, then the guided pad', async () => {
    await introduceItem('kanji', '水', daysAgo(2));
    renderAt('/write/水');
    expect(await screen.findByRole('heading', { name: 'Once from memory (not graded)' })).toBeTruthy();
    // The prompt is the keyword and the anchor with the kanji blanked, never the kanji itself.
    expect(document.querySelector('.st-write-keyword')?.textContent).toBe('water');
    expect(document.querySelector('.st-write-blanked')?.textContent).toBe('· □');
    fireEvent.click(screen.getByRole('button', { name: 'Leave a stroke out' }));
    expect(screen.getByText('Compare your writing with the model.')).toBeTruthy();
    expect(triedToday().has('水')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Practise with the guide' }));
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish writing' }));
    expect(screen.getByText('Nice. Clean strokes.')).toBeTruthy();
    // Nothing is graded.
    expect(await db.reviewLogs.count()).toBe(0);

    // The same day it opens straight on the guided pad.
    cleanup();
    renderAt('/write/水');
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Once from memory (not graded)' })).toBeNull();
  });

  it('never adds a recall for a character introduced today or not yet learned', async () => {
    await introduceItem('kanji', '水');
    renderAt('/write/水');
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Once from memory (not graded)' })).toBeNull();
    cleanup();
    renderAt('/write/木');
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Stroke order of 木/ })).toBeTruthy();
  });

  it('prompts a kana by its sound, and goes back to the kana chart', async () => {
    await introduceItem('kana', 'あ', daysAgo(3));
    renderAt('/write/あ');
    expect(await screen.findByRole('heading', { name: 'Once from memory (not graded)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play the sound' }));
    expect(audioMock.play).toHaveBeenCalledWith({ ref: 'kana:あ' }, expect.anything());
    expect(screen.getByRole('link', { name: /Back/ }).getAttribute('href')).toBe('/kana');
    fireEvent.click(screen.getByRole('button', { name: 'Write it right' }));
    expect(screen.getByText('Written from memory.')).toBeTruthy();
  });

  it('offers the guide instead of a recall pad that can never load (no stroke data)', async () => {
    await introduceItem('kanji', '食', daysAgo(2));
    renderAt('/write/食');
    expect(await screen.findByText('There is no stroke data for this character.')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Practise with the guide' }));
    expect(await screen.findByText('There is no stroke guide for this character yet.')).toBeTruthy();
  });

  it('says so for a character outside the course', async () => {
    renderAt('/write/龍');
    expect(await screen.findByRole('heading', { name: 'Nothing to write here' })).toBeTruthy();
  });

  it('keeps only today’s attempts', () => {
    markTried('水', '2026-10-14');
    markTried('木', dayKey());
    expect(triedToday('2026-10-14').size).toBe(0);
    expect([...triedToday()]).toEqual(['木']);
  });
});

describe('Grammar', () => {
  it('lists grammar by unit, with the register and what is learned', async () => {
    await introduceItem('grammar', 'wa-desu');
    renderAt('/grammar');
    expect(await screen.findByRole('heading', { name: 'Unit 1 · Hello' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Unit 2' })).toBeTruthy();
    expect(screen.getByText('1 of 3 learned. New points arrive in your sessions every other day.')).toBeTruthy();
    const row = screen.getByRole('link', { name: /〜は〜です/ });
    expect(row.getAttribute('href')).toBe('/grammar/wa-desu');
    expect(within(row).getByText('Learned')).toBeTruthy();
    expect(within(row).getByText('Polite')).toBeTruthy();
    expect(within(row).getByText('"X is Y"')).toBeTruthy();
    expect(within(screen.getByRole('link', { name: /〜が/ })).queryByText('Learned')).toBeNull();
  });

  it('groups points by unit in teaching order', () => {
    const shuffled = [GRAMMAR[2], GRAMMAR[0], { ...GRAMMAR[1], unit: 1, order: 0 }];
    expect(byUnit(shuffled).map(([unit, list]) => [unit, list.map((p) => p.id)])).toEqual([[1, ['ga-subject', 'wa-desu']], [3, ['tai']]]);
  });

  it('gives patterns furigana by the setting', async () => {
    GRAMMAR.push({ ...GRAMMAR[2], id: 'ni-iku', order: 4, title: '〜に — at a time, to a place', pattern: '〜{時|じ}に・〜に{行|い}きます', unit: 3 });
    try {
      renderAt('/grammar');
      const row = await screen.findByRole('link', { name: /時/ });
      // Furigana "unknown" (the default): 時 has not been learned, so its reading shows.
      expect(row.querySelector('.st-grammar-pattern rt')?.textContent).toBe('じ');
      expect(row.querySelector('.st-grammar-title')?.textContent).toBe('at a time, to a place');
      cleanup();
      await updateSettings({ furigana: 'never' });
      renderAt('/grammar');
      expect((await screen.findByRole('link', { name: /時/ })).querySelector('rt')).toBeNull();
    } finally {
      GRAMMAR.pop();
    }
  });

  it('shows a point with every example, its links and ungraded practice', async () => {
    renderAt('/grammar/wa-desu');
    expect(await screen.findByRole('heading', { name: '〜は〜です' })).toBeTruthy();
    expect(screen.getByText('Comes in unit 1')).toBeTruthy();
    expect(screen.getByText('It is water.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Listen to this example' })).toHaveLength(GRAMMAR[0].examples.length);
    fireEvent.click(screen.getAllByRole('button', { name: 'Listen to this example' })[1]);
    expect(audioMock.play).toHaveBeenCalledWith({ ref: 'grammar:wa-desu#ex1' }, expect.anything());
    expect(screen.getByRole('link', { name: /〜が/ }).getAttribute('href')).toBe('/grammar/ga-subject');

    fireEvent.click(screen.getByRole('button', { name: 'Fill the gaps' }));
    expect(screen.getByText('Practice 1 / 3')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Answer choices' })).getByRole('button', { name: 'を' }));
    expect(screen.getByText(/Not quite/)).toBeTruthy();
    // The sentence shows the right particle, never the wrong pick painted as filled in.
    expect(document.querySelector('.st-gap.filled')?.textContent).toBe('は');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Practice 2 / 3')).toBeTruthy();

    expect(await db.reviewLogs.count()).toBe(0);
    expect(await db.items.count()).toBe(0);
  });

  it('builds sentences from tiles, one build item after another', async () => {
    renderAt('/grammar/wa-desu');
    fireEvent.click(await screen.findByRole('button', { name: 'Build sentences' }));
    expect(screen.getByRole('heading', { name: 'Build it' })).toBeTruthy();
    expect(screen.getByText('I am a student.', { selector: '.st-english' })).toBeTruthy();
    for (const tile of ['わたし', 'は', 'がくせい', 'です']) {
      fireEvent.click(within(screen.getByRole('group', { name: 'Pieces' })).getByRole('button', { name: tile }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByText('Right')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('It is a book.', { selector: '.st-english' })).toBeTruthy();
  });

  it('says a learned point is in the reviews', async () => {
    await introduceItem('grammar', 'wa-desu');
    renderAt('/grammar/wa-desu');
    expect(await screen.findByText('In your reviews')).toBeTruthy();
  });

  it('says so when a point does not exist', async () => {
    renderAt('/grammar/nope');
    expect(await screen.findByRole('heading', { name: 'Lesson not found' })).toBeTruthy();
  });
});

describe('Reading', () => {
  it('starts a round of sentences at your level', async () => {
    await introduceItem('word', 'w-mizu', daysAgo(2));
    await introduceItem('grammar', 'wa-desu', daysAgo(5));
    renderAt('/read');
    fireEvent.click(await screen.findByRole('button', { name: /Start reading/ }));
    expect(await screen.findByText(/^Read 1 \/ \d$/)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Read it aloud first' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('heading', { name: 'Saved sentences' })).toBeTruthy();
  });

  it('says when no sentence fits yet', async () => {
    renderAt('/read');
    expect(await screen.findByRole('heading', { name: 'No new sentences right now' })).toBeTruthy();
    expect(screen.getByRole('link', { name: "Go to today's session" }).getAttribute('href')).toBe('/session');
  });

  it('lists saved sentences to read and hear again', async () => {
    expect(await saveSentence(SENTENCES[0], 'word:w-mizu')).toBe(true);
    renderAt('/read');
    fireEvent.click(await screen.findByRole('button', { name: /It is water/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Listen' }));
    expect(audioMock.play).toHaveBeenCalledWith({ ref: 'sentence:s-mizu' }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('button', { name: /It is water/ })).toBeTruthy();
  });

  it('opens a Library story, or says it is missing', async () => {
    renderAt('/read/st-l0-01');
    expect(await screen.findByRole('heading', { name: 'Stretch story' })).toBeTruthy();
    cleanup();
    renderAt('/read/st-nope');
    expect(await screen.findByRole('heading', { name: 'Story not found' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('link', { name: 'All stories' }).getAttribute('href')).toBe('/library/stories'));
  });
});
