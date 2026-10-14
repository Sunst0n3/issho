import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import Session from '../../screens/Session.tsx';
import { introduceItem, markKnown } from '../../srs/items.ts';
import { pushStats } from '../../sync/stats.ts';
import { resetStudyDb } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);
vi.mock('../../sync/stats.ts', () => ({ pushStats: vi.fn(async () => true) }));

const HOUR = 60 * 60 * 1000;
const KANA_READ = cardId('kana:あ', 'read');

/** A learner who knows both kana scripts, with one kana card due and the kanji 水 next in the course. */
async function seed({ newPerDay = 1 } = {}) {
  await resetStudyDb({ knowsHiragana: true, knowsKatakana: true, newPerDay });
  await introduceItem('kana', 'あ', new Date(Date.now() - 48 * HOUR));
  await db.cards.update(KANA_READ, { due: new Date(Date.now() - HOUR) });
  await db.cards.update(cardId('kana:あ', 'write'), { due: new Date(Date.now() + 30 * 24 * HOUR) });
}

function renderSession() {
  return render(
    <MemoryRouter initialEntries={['/session']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/session" element={<Session />} />
      </Routes>
    </MemoryRouter>,
  );
}

const choices = () => within(screen.getByRole('group', { name: 'Answer choices' }));
const choice = (name: string) => choices().getByRole('button', { name });
/** Any option but the right one (options are shuffled). */
const wrongChoice = (right: string) => choices().getAllByRole('button').find((b) => b.textContent?.replace(/^\d/, '') !== right)!;
const counter = () => document.querySelector('.st-count')?.textContent;

async function continueOn() {
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
}

/** Answers whichever card of the first check is showing, correctly. */
async function answerCheckCard() {
  const ask = await screen.findByRole('heading', { level: 2 });
  switch (ask.textContent) {
    case 'What does this kanji mean?':
    case 'What does this word mean?':
      fireEvent.click(choice('water'));
      break;
    case 'How do you read this word?':
      fireEvent.click(choice('みず'));
      break;
    case 'Write the kanji for':
      fireEvent.click(screen.getByRole('button', { name: 'Finish writing' }));
      break;
    default:
      throw new Error(`Unexpected card: ${ask.textContent}`);
  }
  await continueOn();
}

beforeEach(() => {
  vi.mocked(pushStats).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Session', () => {
  it('runs reviews, a new kanji with writing, its first check, reading and the summary', async () => {
    await seed();
    renderSession();

    // 1. Review: a wrong answer is graded Again and comes back once, ungraded.
    expect(await screen.findByRole('heading', { name: 'What sound is this hiragana?' })).toBeTruthy();
    expect(counter()).toBe('Review 1 / 1');
    fireEvent.click(wrongChoice('a'));
    expect(await screen.findByText(/Not quite/)).toBeTruthy();
    await waitFor(async () => expect(await db.reviewLogs.where('cardId').equals(KANA_READ).count()).toBe(1));
    expect((await db.reviewLogs.toArray())[0].grade).toBe(1);
    expect(await screen.findByText(/Reviewing again in/)).toBeTruthy();
    await continueOn();

    expect(await screen.findByText('Once more, for practice')).toBeTruthy();
    expect(counter()).toBe('Once more 1 / 1');
    fireEvent.click(choice('a'));
    expect(await screen.findByText('Extra practice: no new grade this time.')).toBeTruthy();
    await continueOn();

    // 2. New kanji: lesson, then trace → guided → memory.
    expect(await screen.findByRole('heading', { name: 'water' })).toBeTruthy();
    expect(counter()).toBe('New 1 / 1');
    expect(screen.getByText('A stream splashing drops to both sides: water.')).toBeTruthy();
    expect(screen.getByText('みず', { selector: '.st-word-kana' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Practice writing it' }));

    for (const mode of ['trace', 'guided', 'memory']) {
      const pad = await screen.findByRole('img', { name: `Writing pad for 水 (${mode})` }, { timeout: 3000 });
      fireEvent.click(within(pad).getByRole('button', { name: 'Finish writing' }));
    }
    expect(await screen.findByText('Nice. You wrote it from memory.')).toBeTruthy();
    expect(await db.items.get('kanji:水')).toBeUndefined();
    await continueOn();

    // 3. The first check covers the kanji's three cards and its word's two.
    await waitFor(() => expect(counter()).toBe('Check 1 / 5'));
    expect(await db.items.get('word:w-mizu')).toBeDefined();
    for (let i = 0; i < 5; i++) await answerCheckCard();

    // 4. Reading the i+1 sentence. Saving sentences starts in phase 3; this is phase 2.
    expect(await screen.findByRole('heading', { name: 'How do you read the underlined word?' })).toBeTruthy();
    expect(counter()).toBe('Read 1 / 1');
    fireEvent.click(choice('みず'));
    expect(await screen.findByText('I drink water.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save sentence' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    // 5. Summary.
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeTruthy();
    const stats = screen.getByText('Reviews').parentElement!;
    expect(within(stats).getByText('6')).toBeTruthy();
    expect(screen.getByText('83%')).toBeTruthy();
    expect(await screen.findByText('1 day streak')).toBeTruthy();
    expect(screen.getByText('water', { selector: '.st-learned-meaning' })).toBeTruthy();

    // Grades: one review, five first checks; the practice repeat added none.
    expect(await db.reviewLogs.where('cardId').equals(KANA_READ).count()).toBe(1);
    expect(await db.reviewLogs.count()).toBe(6);
    const fresh = await db.cards.where('itemId').anyOf('kanji:水', 'word:w-mizu').toArray();
    expect(fresh).toHaveLength(5);
    expect(fresh.every((c) => c.state !== State.New)).toBe(true);
    expect(JSON.parse(localStorage.getItem('issho.srs.sentencesShown') ?? '{}')).toHaveProperty('s-mizu');
    expect((await db.days.toArray()).some((d) => d.sessionComplete)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    await waitFor(() => expect(pushStats).toHaveBeenCalledWith({ immediate: true }));
  }, 20_000);

  it('asks before stopping, and keeps going when asked to', async () => {
    await seed();
    renderSession();
    await screen.findByRole('heading', { name: 'What sound is this hiragana?' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Stop for now?');
    expect(dialog.textContent).toContain('Your progress is saved.');
    const [keep, stop] = within(dialog).getAllByRole('button');
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(stop);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(stop);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'What sound is this hiragana?' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    await waitFor(() => expect(pushStats).toHaveBeenCalled());
    expect((await db.days.toArray()).some((d) => d.sessionComplete)).toBe(false);
  });

  it('completes the day when stopped during reading, the optional last part', async () => {
    await seed({ newPerDay: 0 });
    renderSession();
    await screen.findByRole('heading', { name: 'What sound is this hiragana?' });
    fireEvent.click(choice('a'));
    await continueOn();

    expect(await screen.findByRole('heading', { name: 'What does this mean?' })).toBeTruthy();
    expect(counter()).toBe('Read 1 / 1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    await waitFor(() => expect(pushStats).toHaveBeenCalledWith({ immediate: true }));
    expect((await db.days.toArray()).some((d) => d.sessionComplete)).toBe(true);
  });

  it('skips writing but still introduces the item', async () => {
    await seed();
    await db.cards.update(KANA_READ, { due: new Date(Date.now() + 24 * HOUR) });
    renderSession();

    expect(await screen.findByRole('heading', { name: 'water' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Practice writing it' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip writing' }));
    await waitFor(() => expect(counter()).toBe('Check 1 / 5'));
    expect(await db.items.get('kanji:水')).toBeDefined();
  });

  it('says when the daily review limit, not an empty queue, is why there is nothing to do', async () => {
    await resetStudyDb({ knowsHiragana: true, knowsKatakana: true, newPerDay: 1, maxReviewsPerDay: 0 });
    await markKnown('kana', 'あ');
    await db.cards.update(KANA_READ, { due: new Date(Date.now() - HOUR) });
    renderSession();
    expect(await screen.findByRole('heading', { name: "Today's reviews are done" })).toBeTruthy();
    expect(screen.getByText(/New items are taking a break/)).toBeTruthy();
  });

  it('shows a friendly state when nothing is due and nothing is new', async () => {
    await resetStudyDb({ knowsHiragana: true, knowsKatakana: true, newPerDay: 0 });
    renderSession();
    expect(await screen.findByRole('heading', { name: "You're all caught up" })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Practice writing/ }).getAttribute('href')).toBe('/write');
    expect(screen.getByRole('link', { name: /Read and shadow/ }).getAttribute('href')).toBe('/read');
  });
});
