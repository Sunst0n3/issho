import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoupleQuest, HouseholdResponse, MemberStats, PartnerQuizItem, Quiz } from '../../../shared/api.ts';
import { db, updateSettings } from '../../lib/db.ts';
import type { KanjiEntry, WordEntry } from '../../lib/types.ts';
import QuizRun from '../../screens/QuizRun.tsx';
import type { WritingResult } from '../../writing/WritingPad.tsx';
import { flushQuizResults, refreshQuizzes, resetQuizzes } from './quizzes.ts';

const kanji = (char: string, meaning: string, kun: string[], on: string[], freq: number): KanjiEntry => ({
  char, meanings: [meaning], kun, on, freq, strokeCount: 4, components: [], parts: [],
});
const KANJI: Record<string, KanjiEntry> = Object.fromEntries([
  kanji('水', 'water', ['みず'], ['スイ'], 223),
  kanji('火', 'fire', ['ひ'], ['カ'], 574),
  kanji('曜', 'weekday', [], ['ヨウ'], 940),
  kanji('木', 'tree', ['き'], ['モク'], 317),
  kanji('金', 'gold', ['かね'], ['キン'], 53),
  kanji('土', 'soil', ['つち'], ['ド'], 307),
  kanji('月', 'month', ['つき'], ['ゲツ', 'ガツ'], 23),
  kanji('本', 'book', ['もと'], ['ホン'], 10),
].map((k) => [k.char, k]));

const word = (id: string, written: string, kana: string, meanings: string[], freqRank = 49): WordEntry => ({
  id, written, kana, meanings, pos: ['n'], freqRank, kanji: [written],
});
const WORDS: WordEntry[] = [
  word('1', '月', 'つき', ['Moon']),
  word('2', '月', 'がつ', ['month']),
  word('3', '水', 'みず', ['water'], 1),
];

const QUIZ: Quiz = {
  id: 'q1', kind: 'kanji', fromMemberId: 'ken', toMemberId: 'me', createdAt: '2026-10-14T08:00:00Z',
  items: [{ char: '水' }, { char: '火' }, { char: '曜' }],
};

const PARTNER_ITEMS: PartnerQuizItem[] = [
  { key: 'kanji:水|write', kind: 'write', prompt: 'Write the kanji for "water" · □ みず', answer: '水' },
  { key: 'core:cw-0007|produce', kind: 'produce', prompt: 'Say: "Good morning" (casual)', answer: 'おはよう' },
];
/** Ken answered from his cards; this phone (Aiko) asks. */
const PARTNER_QUIZ: Quiz = {
  id: 'q2', kind: 'partner', fromMemberId: 'ken', toMemberId: 'me', createdAt: '2026-10-14T08:00:00Z', items: PARTNER_ITEMS,
};

const QUEST: CoupleQuest = {
  week: '2026-10-12', minimumDays: {}, togetherSessions: 0, shortfall: 13, met: false, reserveUsed: false, reserveLeft: true, daysLeft: 4,
};
const stats = (id: string, name: string): MemberStats => ({
  member: { id, name, joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1, progress: null, updatedAt: null,
});
const HOUSEHOLD: HouseholdResponse = {
  householdName: 'Home',
  me: 'me',
  sharedStreak: 0,
  quest: QUEST,
  questStreakWeeks: 0,
  members: [stats('me', 'Aiko'), stats('ken', 'Ken')],
};

const mocks = vi.hoisted(() => ({
  getQuizzes: vi.fn(),
  submitQuizResult: vi.fn(),
}));

vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  getQuizzes: mocks.getQuizzes,
  submitQuizResult: mocks.submitQuizResult,
}));
vi.mock('../../sync/socket.ts', () => ({
  useServerStatus: () => 'online',
  onServerEvent: () => () => {},
  onStatusChange: () => () => {},
  connectFromSettings: async () => {},
}));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({ data: HOUSEHOLD, loading: false, refresh: async () => {} }),
  pushStats: async () => true,
}));
vi.mock('../../lib/data.ts', () => ({
  loadKanji: async () => KANJI,
  loadWords: async () => WORDS,
  strokesFor: async () => ['M10 10 L90 10', 'M50 10 L50 90'],
}));
// The real pad is tested on its own; here it just reports a finished attempt.
vi.mock('../../writing/WritingPad.tsx', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const result = (gaveUp: boolean): WritingResult => ({
    mistakes: 0, hintsUsed: 0, strokeCount: 2, gaveUp, failedStrokes: gaveUp ? 2 : 0,
  });
  const WritingPad = forwardRef<unknown, { onComplete?(r: WritingResult): void; label?: string }>(
    function WritingPad({ onComplete, label }, ref) {
      useImperativeHandle(ref, () => ({ undo() {}, clear() {}, hint() {}, giveUp: () => onComplete?.(result(true)) }));
      return <button type="button" onClick={() => onComplete?.(result(false))}>Write {label} cleanly</button>;
    },
  );
  return { WritingPad };
});

function renderQuiz(id = 'q1') {
  return render(
    <MemoryRouter initialEntries={[`/quiz/${id}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/quiz/:id" element={<QuizRun />} /></Routes>
    </MemoryRouter>,
  );
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetQuizzes();
  await updateSettings({ deviceToken: 'token', memberId: 'me', name: 'Aiko' });
  await db.items.bulkPut([
    { id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() },
    { id: 'kanji:火', kind: 'kanji', key: '火', introducedAt: new Date() },
  ]);
  mocks.getQuizzes.mockResolvedValue({ inbox: [QUIZ], sent: [] });
  mocks.submitQuizResult.mockImplementation(async (id: string, r) => ({ ...QUIZ, id, result: { ...r, finishedAt: 'now' } }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QuizRun', () => {
  it('scores meaning and writing, skips new kanji, and sends the result', async () => {
    renderQuiz();

    // 水: right meaning, written cleanly.
    expect(await screen.findByRole('heading', { name: 'What does this kanji mean?' })).toBeTruthy();
    expect(screen.getByText('Quiz from Ken')).toBeTruthy();
    expect(screen.getAllByRole('button').filter((b) => b.className.startsWith('choice'))).toHaveLength(4);
    click('water');
    expect(screen.getByText('Right')).toBeTruthy();
    // The pad needs the stroke data first.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Now write it' }) as HTMLButtonElement).disabled).toBe(false));
    click('Now write it');
    expect(await screen.findByRole('heading', { name: 'Write it from memory' })).toBeTruthy();
    click('Write the kanji for water cleanly');
    expect(screen.getByText('Nicely written')).toBeTruthy();
    click('Next');

    // 火: wrong meaning, then gave up writing.
    await screen.findByText('2 / 3');
    const wrong = screen.getAllByRole('button').find((b) => b.className === 'choice' && b.textContent !== 'fire')!;
    fireEvent.click(wrong);
    expect(screen.getByText('Not quite')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'fire' }).className).toContain('correct');
    click('Now write it');
    click("I don't remember");
    click('Next');

    // 曜: not learned yet, so it's a preview.
    expect(await screen.findByText('New to you')).toBeTruthy();
    expect(screen.getByText('weekday')).toBeTruthy();
    click('Continue');

    expect(await screen.findByRole('heading', { name: '1 / 2' })).toBeTruthy();
    await waitFor(() => expect(mocks.submitQuizResult).toHaveBeenCalledWith('q1', { correct: 1, total: 2, missed: ['火'] }));
    expect(await screen.findByText(/Ken can see your score now/)).toBeTruthy();
    // The v1 "send your hardest kanji" sender is gone: the partner quiz replaced it.
    expect(screen.queryByRole('heading', { name: 'Send back a quiz' })).toBeNull();
  });

  it('keeps the same choices when the quiz list refreshes mid-question', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      renderQuiz();
      await screen.findByRole('heading', { name: 'What does this kanji mean?' });
      const choices = () => screen.getAllByRole('button').filter((b) => b.className.startsWith('choice')).map((b) => b.textContent);
      const before = choices();

      // A reconnect or a stale-data refresh brings a fresh copy of the same quiz.
      random.mockReturnValue(0.99);
      mocks.getQuizzes.mockResolvedValue({ inbox: [{ ...QUIZ }], sent: [] });
      await act(async () => {
        await refreshQuizzes();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(choices()).toEqual(before);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps the score to send later when offline', async () => {
    const { ApiError } = await import('../../sync/client.ts');
    mocks.getQuizzes.mockResolvedValue({ inbox: [{ ...QUIZ, items: [{ char: '曜' }] }], sent: [] });
    mocks.submitQuizResult.mockRejectedValue(new ApiError(0, 'network'));
    renderQuiz();

    await screen.findByRole('button', { name: 'Continue' });
    click('Continue');
    expect(await screen.findByRole('heading', { name: 'All new to you' })).toBeTruthy();
    expect(await screen.findByText(/Your score goes to Ken when you reconnect/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('issho.quizResults.v1')!)).toMatchObject([{ id: 'q1', correct: 0, total: 0 }]);

    // Back online: the queued score goes out, and the screen says so.
    mocks.submitQuizResult.mockImplementation(async (id: string, r) => ({ ...QUIZ, id, result: { ...r, finishedAt: 'now' } }));
    await act(async () => { await flushQuizResults(); });
    expect(await screen.findByText(/Ken can see your score now/)).toBeTruthy();
    expect(screen.queryByText(/when you reconnect/)).toBeNull();
    expect(localStorage.getItem('issho.quizResults.v1')).toBeNull();
  });

  it('says so when a queued score is refused later', async () => {
    const { ApiError } = await import('../../sync/client.ts');
    mocks.getQuizzes.mockResolvedValue({ inbox: [{ ...QUIZ, items: [{ char: '曜' }] }], sent: [] });
    mocks.submitQuizResult.mockRejectedValue(new ApiError(0, 'network'));
    renderQuiz();
    await screen.findByRole('button', { name: 'Continue' });
    click('Continue');
    await screen.findByText(/when you reconnect/);

    mocks.submitQuizResult.mockRejectedValue(new ApiError(404, 'not_found'));
    await act(async () => { await flushQuizResults(); });
    expect(await screen.findByText(/Your score couldn't be sent/)).toBeTruthy();
  });

  it('shows a reading used in the meaning it asks for', async () => {
    await db.items.bulkPut([
      { id: 'kanji:月', kind: 'kanji', key: '月', introducedAt: new Date() },
      { id: 'kanji:本', kind: 'kanji', key: '本', introducedAt: new Date() },
    ]);
    mocks.getQuizzes.mockResolvedValue({ inbox: [{ ...QUIZ, items: [{ char: '月' }, { char: '本' }] }], sent: [] });
    renderQuiz();

    // 月 "month" is がつ, not つき (the moon).
    await screen.findByRole('heading', { name: 'What does this kanji mean?' });
    click('month');
    click('Now write it');
    expect((await screen.findByText('month')).closest('.tg-quiz-target')?.textContent).toBe('month がつ');
    click('Write the kanji for month cleanly');
    click('Next');

    // 本 "book" has no matching word here: the on reading (ホン), never もと (origin).
    await screen.findByText('2 / 2');
    click('book');
    click('Now write it');
    expect((await screen.findByText('book')).closest('.tg-quiz-target')?.textContent).toBe('book ホン');
  });

  it('asks each kanji once, and skips a character Issho does not teach', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.getQuizzes.mockResolvedValue({ inbox: [{ ...QUIZ, items: [{ char: '水' }, { char: '水' }, { char: 'あ' }] }], sent: [] });
      renderQuiz();
      await screen.findByRole('heading', { name: 'What does this kanji mean?' });
      expect(screen.getByText('1 / 2')).toBeTruthy();
      click('water');
      click('Now write it');
      click('Write the kanji for water cleanly');
      click('Next');

      expect(await screen.findByRole('heading', { name: "Not one of Issho's kanji" })).toBeTruthy();
      expect(screen.getByText("Issho doesn't teach this character, so it's skipped.")).toBeTruthy();
      expect(screen.queryByText(/come up in your lessons/)).toBeNull();
      click('Continue');

      await waitFor(() => expect(mocks.submitQuizResult).toHaveBeenCalledWith('q1', { correct: 1, total: 1, missed: [] }));
      expect(screen.getByText('Skipped')).toBeTruthy();
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('same key'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps focus in the quiz and announces progress', async () => {
    renderQuiz();
    const prompt = await screen.findByRole('heading', { name: 'What does this kanji mean?' });
    expect(document.activeElement).toBe(prompt);
    const count = document.querySelector('.tg-rp-count')!;
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(count.textContent).toContain('Kanji 1 of 3');

    // Picking switches the choices off: focus moves on to what comes next.
    screen.getByRole('button', { name: 'water' }).focus();
    click('water');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Now write it' })));
    click('Now write it');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Write it from memory' }));
    screen.getByRole('button', { name: "I don't remember" }).focus();
    click("I don't remember");
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    click('Next');
    expect(document.activeElement).toBe(await screen.findByRole('heading', { name: 'What does this kanji mean?' }));
  });

  it('shows a finished quiz instead of replaying it', async () => {
    mocks.getQuizzes.mockResolvedValue({
      inbox: [{ ...QUIZ, result: { correct: 2, total: 2, missed: [], finishedAt: '2026-10-14T09:00:00Z' } }],
      sent: [],
    });
    renderQuiz();
    expect(await screen.findByRole('heading', { level: 1, name: 'Quiz from Ken' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('2 / 2')).toBeTruthy();
    // 曜 wasn't scored: it was new to this learner.
    expect(await screen.findByText(/1 new to you/)).toBeTruthy();
    expect(screen.queryByText(/skipped/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What does this kanji mean?' })).toBeNull();
  });

  it('counts a character Issho does not teach as skipped, not new, in the summary', async () => {
    mocks.getQuizzes.mockResolvedValue({
      inbox: [{ ...QUIZ, items: [{ char: '水' }, { char: '龘' }], result: { correct: 1, total: 1, missed: [], finishedAt: '2026-10-14T09:00:00Z' } }],
      sent: [],
    });
    renderQuiz();
    expect(await screen.findByText(/1 skipped/)).toBeTruthy();
    expect(screen.queryByText(/new to you/)).toBeNull();
  });

  it('words an all-new quiz the same way as the Together list', async () => {
    const allNew = { correct: 0, total: 0, missed: [], finishedAt: '2026-10-14T09:00:00Z' };
    mocks.getQuizzes.mockResolvedValue({ inbox: [{ ...QUIZ, result: allNew }], sent: [] });
    const first = renderQuiz();
    expect(await screen.findByText('All new to you')).toBeTruthy();
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
    first.unmount();

    localStorage.clear();
    resetQuizzes();
    mocks.getQuizzes.mockResolvedValue({ inbox: [], sent: [{ ...QUIZ, fromMemberId: 'me', toMemberId: 'ken', result: allNew }] });
    renderQuiz();
    expect(await screen.findByText('All 3 kanji were new to Ken')).toBeTruthy();
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
  });

  it('explains when the quiz is gone', async () => {
    mocks.getQuizzes.mockResolvedValue({ inbox: [], sent: [] });
    renderQuiz();
    expect(await screen.findByText("This quiz isn't here anymore")).toBeTruthy();
  });

  describe('together quizzes', () => {
    it('shows the asker each prompt with its answer and posts one verdict per item', async () => {
      mocks.getQuizzes.mockResolvedValue({ inbox: [PARTNER_QUIZ], sent: [] });
      mocks.submitQuizResult.mockImplementation(async (id: string, r) => ({ ...PARTNER_QUIZ, id, result: { ...r, finishedAt: 'now' } }));
      renderQuiz('q2');

      expect(await screen.findByText(/You ask Ken · 1 of 2/)).toBeTruthy();
      expect(screen.getByText('Write the kanji for "water" · □ みず')).toBeTruthy();
      expect(screen.getByText('Answer')).toBeTruthy();
      for (const name of ['Right', 'Close', 'Not yet']) expect(screen.getByRole('button', { name })).toBeTruthy();
      // Two taps before the screen updates give one verdict: the second item is still asked.
      const close = screen.getByRole('button', { name: 'Close' });
      act(() => { close.click(); close.click(); });
      expect(await screen.findByText(/You ask Ken · 2 of 2/)).toBeTruthy();
      expect(screen.getByText('おはよう')).toBeTruthy();
      click('Right');

      expect(await screen.findByRole('heading', { name: '1 / 2' })).toBeTruthy();
      await waitFor(() => expect(mocks.submitQuizResult).toHaveBeenCalledWith('q2', {
        correct: 1,
        total: 2,
        missed: ['kanji:水|write'],
        verdicts: [
          { key: 'kanji:水|write', verdict: 'close' },
          { key: 'core:cw-0007|produce', verdict: 'right' },
        ],
      }));
    });

    it('never shows the answerer the answers', async () => {
      const mine: Quiz = { ...PARTNER_QUIZ, id: 'q3', fromMemberId: 'me', toMemberId: 'ken' };
      mocks.getQuizzes.mockResolvedValue({ inbox: [], sent: [mine] });
      renderQuiz('q3');

      expect(await screen.findByRole('heading', { name: 'Your turn: answer out loud or write' })).toBeTruthy();
      expect(screen.queryByText('Answer')).toBeNull();
      expect(screen.queryByText('水', { exact: true })).toBeNull();
      click('Next');
      expect(await screen.findByText('2 of 2')).toBeTruthy();
      expect(screen.queryByText('おはよう')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Right' })).toBeNull();
    });

    it('names your own quiz once, and shows a read item\u2019s word but not its reading', async () => {
      const read: PartnerQuizItem = { key: 'core:cw-0189|read', kind: 'read', prompt: '言う', answer: 'いう' };
      const mine: Quiz = { ...PARTNER_QUIZ, id: 'q4', fromMemberId: 'me', toMemberId: 'ken', items: [read] };
      mocks.getQuizzes.mockResolvedValue({ inbox: [], sent: [mine] });
      renderQuiz('q4');

      expect(await screen.findByRole('heading', { name: 'Your quiz', level: 1 })).toBeTruthy();
      expect(screen.getAllByText('Your quiz')).toHaveLength(1);
      expect(screen.getByText('言う')).toBeTruthy();
      expect(screen.queryByText('いう')).toBeNull();
    });

    it('still runs a kanji quiz cached without a kind by a v1 phone', async () => {
      const { kind: _kind, ...old } = QUIZ;
      mocks.getQuizzes.mockResolvedValue({ inbox: [old], sent: [] });
      renderQuiz();
      expect(await screen.findByRole('heading', { name: 'What does this kanji mean?' })).toBeTruthy();
    });
  });
});
