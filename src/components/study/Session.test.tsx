import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import Session from '../../screens/Session.tsx';
import { introduceItem, markKnown } from '../../srs/items.ts';
import { pushStats } from '../../sync/stats.ts';
import { GRAMMAR, resetStudyDb, SENTENCES } from './test-utils.tsx';

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

let navigateTo: NavigateFunction;
/** Gives the test the router's navigate, to press the browser's back button. */
function NavProbe() {
  navigateTo = useNavigate();
  return null;
}

function renderSession() {
  return render(
    <MemoryRouter initialEntries={['/', '/session']} initialIndex={1} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <NavProbe />
      <Routes>
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/session" element={<Session />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The browser's back button (or Android's back gesture), once the screen has settled. */
async function pressBack() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    navigateTo(-1);
  });
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
    expect(screen.getByText('みず', { selector: '.st-word-kana [lang="ja"]' })).toBeTruthy();
    // With romaji on (the default), the lesson's words show it too.
    expect(screen.getByText('mizu', { selector: '.st-word-kana .st-romaji' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Practice writing it' }));

    // The pad is named by its character while it is traced, then by what to write.
    for (const [mode, name] of [['trace', '水'], ['guided', 'the kanji for "water" (みず)'], ['memory', 'the kanji for "water" (みず)']]) {
      const pad = await screen.findByRole('img', { name: `Writing pad for ${name} (${mode})` }, { timeout: 3000 });
      fireEvent.click(within(pad).getByRole('button', { name: 'Finish writing' }));
    }
    expect(await screen.findByText('Nice. You wrote it from memory.')).toBeTruthy();
    expect(await db.items.get('kanji:水')).toBeUndefined();
    await continueOn();

    // 3. A quick first check: the kanji's meaning and writing, and its word's reading. The kanji's
    // reading (the word asks it) and the word's meaning (its feedback shows it) wait for tomorrow.
    await waitFor(() => expect(counter()).toBe('Check 1 / 3'));
    expect(await db.items.get('word:w-mizu')).toBeDefined();
    for (let i = 0; i < 3; i++) await answerCheckCard();

    // 4. Reading the i+1 sentence, picked after the lesson so it uses 水. Saving sentences starts in phase 3; this is phase 2.
    expect(await screen.findByRole('heading', { name: /^How do you read the underlined word\?/ })).toBeTruthy();
    expect(counter()).toBe('Read 1 / 1');
    fireEvent.click(choice('みず'));
    expect(await screen.findByText('I drink water.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save sentence' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    // 5. Summary, with focus on its title (the Finish button is gone).
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Session complete' }));
    const stats = screen.getByText('Reviews').parentElement!;
    expect(within(stats).getByText('4')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(await screen.findByText('1-day streak')).toBeTruthy();
    expect(await screen.findByText('water', { selector: '.st-learned-meaning' })).toBeTruthy();

    // Grades: one review, three first checks; the practice repeat added none.
    expect(await db.reviewLogs.where('cardId').equals(KANA_READ).count()).toBe(1);
    expect(await db.reviewLogs.count()).toBe(4);
    const fresh = await db.cards.where('itemId').anyOf('kanji:水', 'word:w-mizu').toArray();
    expect(fresh).toHaveLength(5);
    const waiting = fresh.filter((c) => c.state === State.New);
    expect(waiting.map((c) => c.id).sort()).toEqual([cardId('kanji:水', 'reading'), cardId('word:w-mizu', 'meaning')]);
    // They come with the next study day's reviews, not as due right away.
    expect(waiting.every((c) => c.due.getTime() > Date.now() && c.due.getHours() === 4)).toBe(true);
    expect(JSON.parse(localStorage.getItem('issho.srs.sentencesShown') ?? '{}')).toHaveProperty('s-mizu');
    expect((await db.days.toArray()).some((d) => d.sessionComplete)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    await waitFor(() => expect(pushStats).toHaveBeenCalledWith({ immediate: true }));
    // Back from Today doesn't land in the finished session.
    await pressBack();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByText('Home screen')).toBeTruthy();
    expect(screen.queryByLabelText("Planning today's session")).toBeNull();
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

    // The session's history entry went with it (and its back guard): back from Today doesn't reopen it.
    await pressBack();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByText('Home screen')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'What sound is this hiragana?' })).toBeNull();
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
    await waitFor(() => expect(counter()).toBe('Check 1 / 3'));
    expect(await db.items.get('kanji:水')).toBeDefined();
  });

  it("picks the reading after the new items, so it can use the kanji just learned", async () => {
    await seed();
    await db.cards.update(KANA_READ, { due: new Date(Date.now() + 24 * HOUR) });
    // Two kanji not learned yet when the session opens: too many for i+1 until 水 is learned.
    const fresh = { id: 's-mizu-ki', jp: '{水|みず}と{木|き}。', en: 'Water and trees.' };
    SENTENCES.unshift(fresh);
    try {
      renderSession();
      expect(await screen.findByRole('heading', { name: 'water' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Practice writing it' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Skip writing' }));
      await waitFor(() => expect(counter()).toBe('Check 1 / 3'));
      for (let i = 0; i < 3; i++) await answerCheckCard();

      expect(await screen.findByRole('heading', { name: /^How do you read the underlined word\?/ })).toBeTruthy();
      // 木 is still new, so its furigana shows.
      expect(document.querySelector('.st-sentence')?.textContent).toBe('水と木き。');
      expect(document.querySelector('.st-target')?.textContent).toBe('水');
    } finally {
      SENTENCES.splice(SENTENCES.indexOf(fresh), 1);
    }
  });

  it('asks before stopping when the back gesture is used, like the close button', async () => {
    await seed();
    renderSession();
    await screen.findByRole('heading', { name: 'What sound is this hiragana?' });

    await pressBack();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Stop for now?');
    expect(screen.queryByText('Home screen')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'What sound is this hiragana?' })).toBeTruthy();

    // Kept going: back asks again, and Stop leaves.
    await pressBack();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    await waitFor(() => expect(pushStats).toHaveBeenCalled());
  });

  it('lists everything learned today in the summary, also from an earlier sitting', async () => {
    await seed({ newPerDay: 2 });
    await db.cards.update(KANA_READ, { due: new Date(Date.now() + 24 * HOUR) });
    // Learned earlier today, in a sitting that was stopped before its first check (which then waits).
    await introduceItem('kana', 'い');
    await db.cards.where('itemId').equals('kana:い').modify({ due: new Date(Date.now() + 24 * HOUR) });
    renderSession();

    // This sitting: the grammar point, its practice and its first check.
    fireEvent.click(await screen.findByRole('button', { name: 'Try it' }));
    for (const next of ['Next', 'Done']) {
      fireEvent.click(choices().getAllByRole('button')[0]);
      fireEvent.click(screen.getByRole('button', { name: next }));
    }
    expect(await screen.findByRole('heading', { name: 'Fill the gap' })).toBeTruthy();
    const drill = GRAMMAR[0].drills.find((d) => d.en === document.querySelector('.st-drill-en')?.textContent)!;
    fireEvent.click(choice(drill.options[drill.answer]));
    await continueOn();
    if (await screen.findByRole('heading', { name: 'What does this mean?' }).catch(() => null)) {
      fireEvent.click(choices().getAllByRole('button')[0]);
      fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    }

    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeTruthy();
    await waitFor(() => expect([...document.querySelectorAll('.st-learned-meaning')].map((e) => e.textContent)).toEqual(['i', 'grammar']));
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
