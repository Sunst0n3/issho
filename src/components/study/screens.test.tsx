import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db, updateSettings } from '../../lib/db.ts';
import GrammarDetail from '../../screens/GrammarDetail.tsx';
import GrammarList from '../../screens/GrammarList.tsx';
import Reading from '../../screens/Reading.tsx';
import WritePractice from '../../screens/WritePractice.tsx';
import { introduceItem } from '../../srs/items.ts';
import { gradeCard } from '../../srs/scheduler.ts';
import { saveSentence } from './sentences.ts';
import { resetStudyDb, SENTENCES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);

let navigateTo: NavigateFunction;
/** Gives the test the router's navigate, to press the browser's back button. */
function NavProbe() {
  navigateTo = useNavigate();
  return null;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={['/', path]} initialIndex={1} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <NavProbe />
      <Routes>
        <Route path="/" element={<p>Today screen</p>} />
        <Route path="/write" element={<WritePractice />} />
        <Route path="/grammar" element={<GrammarList />} />
        <Route path="/grammar/:id" element={<GrammarDetail />} />
        <Route path="/read" element={<Reading />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await resetStudyDb({ knowsHiragana: true, knowsKatakana: true });
});

afterEach(() => {
  cleanup();
});

describe('WritePractice', () => {
  it('points to the session before anything is learned', async () => {
    renderAt('/write');
    expect(await screen.findByRole('heading', { name: 'Nothing to write yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: "Start today's session" }).getAttribute('href')).toBe('/session');
  });

  it('lists learned kana and kanji, and practices one in any mode', async () => {
    await introduceItem('kanji', '水');
    await introduceItem('kana', 'あ');
    await introduceItem('kana', 'きゃ');
    renderAt('/write');

    expect(await screen.findByRole('button', { name: '水, water' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'あ, a' })).toBeTruthy();
    // Yōon have no strokes of their own.
    expect(screen.queryByRole('button', { name: /きゃ/ })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Needs work' }));
    expect(screen.getByText(/Nothing needs extra work right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Recent' }));

    fireEvent.click(screen.getByRole('button', { name: '水, water' }));
    expect(screen.getByRole('heading', { name: 'Write the kanji for' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Trace' }));
    expect(await screen.findByRole('img', { name: 'Writing pad for 水 (trace)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish writing' }));
    expect(screen.getByText('Nice. Clean strokes.')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show the strokes' }));
    expect(screen.getByRole('img', { name: /Stroke order animation for 水/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Next random/ }));
    expect(await screen.findByRole('heading', { name: 'Write the hiragana for' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all characters' }));
    expect(await screen.findByRole('button', { name: '水, water' })).toBeTruthy();
    expect(screen.getByText('Pick a character to practice. Nothing here is graded.')).toBeTruthy();
  });

  it('the back gesture from a practice pad returns to the character list, not out of the Write tab', async () => {
    await introduceItem('kanji', '水');
    await introduceItem('kana', 'あ');
    renderAt('/write');
    fireEvent.click(await screen.findByRole('radio', { name: 'All learned' }));
    fireEvent.click(await screen.findByRole('button', { name: '水, water' }));
    expect(await screen.findByRole('heading', { name: 'Write the kanji for' })).toBeTruthy();
    // "Next random" swaps the character without adding a step to go back through.
    fireEvent.click(screen.getByRole('button', { name: /Next random/ }));
    expect(await screen.findByRole('heading', { name: 'Write the hiragana for' })).toBeTruthy();

    await act(async () => {
      navigateTo(-1);
    });
    expect(await screen.findByRole('button', { name: '水, water' })).toBeTruthy();
    expect(screen.queryByText('Today screen')).toBeNull();
    // The list kept its tab.
    expect(screen.getByRole('radio', { name: 'All learned' }).getAttribute('aria-checked')).toBe('true');
  });

  it('lists characters missed while still being learned under Needs work', async () => {
    await introduceItem('kana', 'あ');
    await introduceItem('kana', 'い');
    await gradeCard(cardId('kana:あ', 'read'), Rating.Again, { durationMs: 1000, mode: 'choice' });
    await gradeCard(cardId('kana:あ', 'write'), Rating.Again, { durationMs: 1000, mode: 'written' });
    await gradeCard(cardId('kana:い', 'write'), Rating.Good, { durationMs: 1000, mode: 'written' });
    expect((await db.cards.get(cardId('kana:あ', 'read')))?.lapses).toBe(0);
    renderAt('/write');
    fireEvent.click(await screen.findByRole('radio', { name: 'Needs work' }));
    expect(screen.getByRole('button', { name: 'あ, a' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'い, i' })).toBeNull();
  });

  it('collects characters with lapses under Needs work', async () => {
    await introduceItem('kanji', '水');
    await introduceItem('kanji', '火');
    await db.cards.update(cardId('kanji:火', 'write'), { reps: 3, lapses: 2, stability: 1 });
    renderAt('/write');
    fireEvent.click(await screen.findByRole('radio', { name: 'Needs work' }));
    expect(screen.getByRole('button', { name: '火, fire' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '水, water' })).toBeNull();
  });
});

describe('Grammar', () => {
  it('lists grammar by phase with what is learned', async () => {
    await introduceItem('grammar', 'wa-desu');
    renderAt('/grammar');
    expect(await screen.findByRole('heading', { name: /Phase 1/ })).toBeTruthy();
    const row = screen.getByRole('link', { name: /〜は〜です/ });
    expect(row.getAttribute('href')).toBe('/grammar/wa-desu');
    expect(within(row).getByText('Learned')).toBeTruthy();
    expect(within(row).getByText('"X is Y"')).toBeTruthy();
  });

  it('gives patterns furigana by the setting, and marks Japanese inside the English', async () => {
    const { GRAMMAR } = await import('./test-utils.tsx');
    GRAMMAR.push({
      id: 'ni-iku', order: 2, phase: 2, title: '〜に — at a time, to a place', pattern: '〜{時|じ}に・〜に{行|い}きます',
      explanation: 'に marks a time.', examples: [], drills: [],
    });
    try {
      renderAt('/grammar');
      const row = await screen.findByRole('link', { name: /時/ });
      // Furigana "unknown" (the default): 時 has not been learned, so its reading shows.
      expect(row.querySelector('.st-grammar-pattern rt')?.textContent).toBe('じ');
      // The title doesn't repeat the pattern in kana; the Japanese in it is marked.
      expect(row.querySelector('.st-grammar-title')?.textContent).toBe('at a time, to a place');
      cleanup();
      await updateSettings({ furigana: 'never' });
      renderAt('/grammar');
      expect((await screen.findByRole('link', { name: /時/ })).querySelector('rt')).toBeNull();
    } finally {
      GRAMMAR.pop();
    }
  });

  it('shows a point with ungraded practice, and can learn it now', async () => {
    renderAt('/grammar/wa-desu');
    expect(await screen.findByRole('heading', { name: '〜は〜です' })).toBeTruthy();
    expect(screen.getByText('It is water.')).toBeTruthy();

    expect(screen.getByText('Practice 1 / 3')).toBeTruthy();
    expect(document.querySelector('.st-explanation [lang="ja"]')?.textContent).toBe('は');
    fireEvent.click(within(screen.getByRole('group', { name: 'Answer choices' })).getByRole('button', { name: 'を' }));
    expect(screen.getByText(/Not quite/)).toBeTruthy();
    // The sentence shows the right particle, never the wrong pick painted as filled in.
    expect(document.querySelector('.st-gap.filled')?.textContent).toBe('は');
    expect(document.querySelector('.st-drill-sentence')?.textContent).toBe('わたしはがくせいです。');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Practice 2 / 3')).toBeTruthy();
    expect(await db.reviewLogs.count()).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Learn this now' }));
    expect(await screen.findByText('In your reviews')).toBeTruthy();
    expect(await db.cards.get(cardId('grammar:wa-desu', 'drill'))).toBeDefined();
  });

  it('says so when learning a point fails, and can try again', async () => {
    renderAt('/grammar/wa-desu');
    const learn = await screen.findByRole('button', { name: 'Learn this now' });
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(() => Promise.reject(new Error('disk full')) as never);
    fireEvent.click(learn);
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't save it to your reviews");
    transaction.mockRestore();

    fireEvent.click(screen.getByRole('button', { name: 'Learn this now' }));
    expect(await screen.findByText('In your reviews')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when a point does not exist', async () => {
    renderAt('/grammar/nope');
    expect(await screen.findByRole('heading', { name: 'Lesson not found' })).toBeTruthy();
  });
});

describe('Reading', () => {
  it('says saving starts in phase 3, and that each sentence has at most one new kanji', async () => {
    await introduceItem('kanji', '水');
    renderAt('/read');
    expect(await screen.findByText(/at most one new kanji each/)).toBeTruthy();
    expect(await screen.findByText(/From phase 3 you can save sentences while reading/)).toBeTruthy();
  });

  it('starts a round of sentences at your level', async () => {
    await introduceItem('kanji', '水');
    renderAt('/read');
    fireEvent.click(await screen.findByRole('button', { name: /Start reading/ }));
    expect(await screen.findByText('Read 1 / 1')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /^How do you read the underlined word\?/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('heading', { name: 'Saved sentences' })).toBeTruthy();
  });

  it('lists saved sentences to read again or remove', async () => {
    await saveSentence(SENTENCES[0]);
    renderAt('/read');
    const saved = await screen.findByRole('button', { name: /I drink water/ });
    fireEvent.click(saved);
    expect(await screen.findByText('Read 1 / 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from saved' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /I drink water/ })).toBeNull());
    expect((await db.cards.get(cardId('sentence:s-mizu', 'read')))?.suspended).toBe(true);
  });
});
