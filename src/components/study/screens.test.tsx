import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import GrammarDetail from '../../screens/GrammarDetail.tsx';
import GrammarList from '../../screens/GrammarList.tsx';
import Reading from '../../screens/Reading.tsx';
import WritePractice from '../../screens/WritePractice.tsx';
import { introduceItem } from '../../srs/items.ts';
import { saveSentence } from './sentences.ts';
import { resetStudyDb, SENTENCES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
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

  it('lists learned kana and kanji, and practises one in any mode', async () => {
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
    expect(screen.getByRole('heading', { name: 'Write the hiragana for' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all characters' }));
    expect(await screen.findByRole('button', { name: '水, water' })).toBeTruthy();
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

  it('shows a point with ungraded practice, and can learn it now', async () => {
    renderAt('/grammar/wa-desu');
    expect(await screen.findByRole('heading', { name: '〜は〜です' })).toBeTruthy();
    expect(screen.getByText('It is water.')).toBeTruthy();

    expect(screen.getByText('Practice 1 / 3')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Answer choices' })).getByRole('button', { name: 'を' }));
    expect(screen.getByText(/Not quite/)).toBeTruthy();
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
  it('starts a round of sentences at your level', async () => {
    await introduceItem('kanji', '水');
    renderAt('/read');
    fireEvent.click(await screen.findByRole('button', { name: /Start reading/ }));
    expect(await screen.findByText('Read 1 / 1')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'How do you read the underlined word?' })).toBeTruthy();
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
