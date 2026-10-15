import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HouseholdResponse,
  MemberProgress,
  MemberStats,
  PartnerQuizItem,
  Quiz,
  TogetherEvent,
  TogetherLiveState,
  TogetherSlot,
} from '../../../shared/api.ts';
import type { WordInfo } from '../../lib/data.ts';
import { dayKey, db, updateSettings } from '../../lib/db.ts';
import type { RolePlay, StoryEntry, TaskCard, TogetherWeekPlan, UnitSpec } from '../../lib/types.ts';
import TogetherSession from '../../screens/TogetherSession.tsx';
import { resetAiAvailability } from './ai.ts';
import { CheckIn } from './CheckIn.tsx';
import { resetQuizzes } from './quizzes.ts';
import { resetLiveInvites } from './session.ts';

// ---- Content -----------------------------------------------------------------------

const roles = { a: { name: 'Guest', nameJp: 'きゃく' }, b: { name: 'Clerk', nameJp: 'てんいん' } };
const script = (id: string, title: string, unit?: number): RolePlay => ({
  id, title, titleJp: title, unit, level: 1, setting: '', register: 'plain', targets: [], roles,
  lines: [
    { role: 'a', jp: 'すしを ください。', en: 'Sushi, please.', cue: 'sushi · please' },
    { role: 'b', jp: 'はい、どうぞ。', en: 'Here you are.', cue: '' },
  ],
});
const SCRIPTS = [script('rp-u01', 'Hello again', 1), script('rp-u02', 'Weekend plans', 2), script('rp-free', 'At the café')];

const TASK: TaskCard = {
  id: 'u01-task', canDo: 'u01-cd1', goal: 'Order lunch for both of you', outcomeQuestion: 'What did you order?',
  roles: { a: 'You', b: 'Your partner' }, infoA: 'You want sushi.', infoB: 'You want ramen.',
  targets: ['core:cw-1', 'core:cw-3'], register: 'mixed', twist: 'The café is out of sushi.', aiRole: 'clerk',
  scripted: [
    { role: 'a', jp: 'すしを ください。', en: 'Sushi, please.' },
    { role: 'b', jp: 'ラーメンを ください。', en: 'Ramen, please.' },
  ],
  ready: true,
};
const UNITS = [{
  id: 1, title: 'Hello', titleJp: 'こんにちは', level: 'A1', topic: '', grammar: ['wa-desu'], coreWordCeiling: 50,
  canDos: [{ id: 'u01-cd1', text: 'Order food', check: { kind: 'read', instructions: '', material: '', questions: [] }, ready: true }],
  conversation: 'rp-u01', task: TASK,
  capstone: { title: 'Lunch date', brief: 'Plan a lunch together.', minLinesEach: 2, structures: ['〜を ください', '〜が すき'] },
}] as UnitSpec[];
const STORIES = [{ id: 'st-1', title: 'The cat next door', titleJp: 'となりの ねこ', sentences: [] }] as unknown as StoryEntry[];

const ITEMS: PartnerQuizItem[] = [
  { key: 'kanji:水|write', kind: 'write', prompt: 'Write the kanji for "water" · □ みず', answer: '水' },
  { key: 'core:cw-1|produce', kind: 'produce', prompt: 'Say "sushi"', answer: 'すし' },
];

// ---- Household -------------------------------------------------------------------------

const PARTNER_PROGRESS = {
  recentKanji: ['木'], recentItems: ['core:cw-2'], settledUnit: 1, coreReached: 10, grammarReached: 2,
} as MemberProgress;
const stats = (id: string, name: string, progress: MemberProgress | null): MemberStats => ({
  member: { id, name, joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1, progress, updatedAt: null,
});
const HOUSEHOLD: HouseholdResponse = {
  householdName: 'Home', me: 'me', sharedStreak: 0, questStreakWeeks: 0,
  quest: { week: '2026-10-12', minimumDays: {}, togetherSessions: 0, shortfall: 13, met: false, reserveUsed: false, reserveLeft: true, daysLeft: 4 },
  members: [stats('me', 'Aiko', null), stats('ken', 'Ken', PARTNER_PROGRESS)],
};

const weekPlan = (patch: Partial<TogetherWeekPlan>): TogetherWeekPlan => ({
  week: '2026-10-12', sessions: [], settledUnit: 1, monthly: false, showcase: false, ...patch,
});

// ---- Mocks ------------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  status: 'offline' as 'online' | 'offline',
  presence: undefined as boolean | undefined,
  aiEnabled: false,
  plan: undefined as unknown as TogetherWeekPlan,
  live: new Set<(memberId: string, state: TogetherLiveState) => void>(),
  sendLive: vi.fn((_state: TogetherLiveState) => true),
  postTogetherEvent: vi.fn(async (_event: TogetherEvent) => {}),
  creditTogetherSession: vi.fn(async () => true),
  spendRestToken: vi.fn(async () => 'ok' as const),
  buildQuizPool: vi.fn(async (_kind: string): Promise<PartnerQuizItem[]> => []),
  applyLocalVerdicts: vi.fn(async () => ({ graded: 1, practiced: 0 })),
  teachMeKanji: vi.fn(async () => '水'),
  taskTargets: vi.fn((): string[] => ['core:cw-1', 'core:cw-2']),
  weeklyCheckinCounts: vi.fn(async () => ({ kanji: 3, words: 12, grammar: 1, minutes: 95 })),
  memberProgress: vi.fn(async () => ({ recentItems: ['core:cw-1'] })),
  createGuardedCloze: vi.fn(async (): Promise<string | null> => null),
  canDoStatus: vi.fn(async () => new Map([['u01-cd1', { id: 'u01-cd1', unit: 1, attempts: 1, passedAt: new Date(), via: 'auto' as const }]])),
  recordCanDoAttempt: vi.fn(),
  createQuiz: vi.fn(),
  getQuizzes: vi.fn(),
  submitQuizResult: vi.fn(),
  aiRolePlay: vi.fn(),
  aiRecap: vi.fn(),
  play: vi.fn(async () => ({ via: 'device' as const, ms: 0, interrupted: false })),
  /** Speech recognition: off unless a test turns it on. */
  recognition: false,
  heard: '',
}));

vi.mock('../../sync/together.ts', () => ({
  postTogetherEvent: mocks.postTogetherEvent,
  useTogetherState: () => ({ state: null, offline: mocks.status === 'offline', refresh: async () => {} }),
  onLive: (cb: (memberId: string, state: TogetherLiveState) => void) => {
    mocks.live.add(cb);
    return () => { mocks.live.delete(cb); };
  },
  sendLive: mocks.sendLive,
}));
vi.mock('../../sync/socket.ts', () => ({
  useServerStatus: () => mocks.status,
  usePresence: () => mocks.presence,
  onServerEvent: () => () => {},
  onStatusChange: () => () => {},
  sendClientEvent: () => true,
}));
vi.mock('../../sync/stats.ts', () => ({ useHousehold: () => ({ data: HOUSEHOLD, loading: false, refresh: async () => {} }) }));
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  health: async () => ({ ok: true, version: '1', aiEnabled: mocks.aiEnabled, ttsEnabled: false }),
  createQuiz: mocks.createQuiz,
  getQuizzes: mocks.getQuizzes,
  submitQuizResult: mocks.submitQuizResult,
  aiRolePlay: mocks.aiRolePlay,
  aiRecap: mocks.aiRecap,
}));
vi.mock('../../srs/together.ts', () => ({
  loadWeekPlan: async () => mocks.plan,
  buildQuizPool: mocks.buildQuizPool,
  applyLocalVerdicts: mocks.applyLocalVerdicts,
  teachMeKanji: mocks.teachMeKanji,
  taskTargets: mocks.taskTargets,
  weeklyCheckinCounts: mocks.weeklyCheckinCounts,
}));
vi.mock('../../srs/habits.ts', () => ({ creditTogetherSession: mocks.creditTogetherSession, spendRestToken: mocks.spendRestToken }));
vi.mock('../../srs/memberProgress.ts', () => ({ memberProgress: mocks.memberProgress }));
vi.mock('../../srs/output.ts', () => ({ learnerAiContext: async () => ({ knownGrammar: ['wa-desu'] }) }));
vi.mock('../../srs/sentenceGuard.ts', () => ({ createGuardedCloze: mocks.createGuardedCloze }));
vi.mock('../../srs/candos.ts', () => ({ canDoStatus: mocks.canDoStatus, recordCanDoAttempt: mocks.recordCanDoAttempt }));
vi.mock('../../speech/audio.ts', () => ({ play: mocks.play, stopAudio: () => {} }));
vi.mock('../../speech/recognition.ts', () => ({
  recognitionAvailable: () => mocks.recognition,
  listen: () => ({ result: Promise.resolve(mocks.heard), stop: () => {} }),
}));
vi.mock('../../lib/data.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/data.ts')>()),
  loadUnits: async () => UNITS,
  loadRolePlays: async () => SCRIPTS,
  loadStories: async () => STORIES,
  loadKanji: async () => ({ 木: { char: '木', meanings: ['tree'] }, 水: { char: '水', meanings: ['water'] } }),
  loadGrammarIndex: async () => new Map(),
  strokesFor: async () => ['M10 10 L90 10'],
  loadWordInfo: async () => (ref: string): WordInfo | undefined => ({
    'core:cw-1': { ref: 'core:cw-1', written: 'すし', kana: 'すし', en: 'sushi', kanji: [], use: true, readings: ['すし'] },
    'core:cw-2': { ref: 'core:cw-2', written: 'ラーメン', kana: 'ラーメン', en: 'ramen', kanji: [], use: true, readings: ['ラーメン'] },
  } as Record<string, WordInfo>)[ref],
}));
vi.mock('../../screens/CanDoCheck.tsx', () => ({
  CanDoCheckView: ({ canDo, showcase }: { canDo: { text: string }; showcase?: boolean }) => (
    <p>Check: {canDo.text}{showcase ? ' (showcase)' : ''}</p>
  ),
}));
vi.mock('../../writing/WritingPad.tsx', () => ({
  WritingPad: ({ label }: { label?: string }) => <div role="img" aria-label={`Pad for ${label}`} />,
}));

// ---- Helpers --------------------------------------------------------------------------

function renderSession(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/together/session/${id}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/together/session/:id" element={<TogetherSession />} /></Routes>
    </MemoryRouter>,
  );
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const clickSoon = async (name: string | RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const emit = (memberId: string, state: TogetherLiveState) => act(() => { for (const cb of [...mocks.live]) cb(memberId, state); });
const events = () => mocks.postTogetherEvent.mock.calls.map(([e]) => e);

/** Silent planning: start it, then let 91 seconds pass. */
async function passPlanning() {
  await clickSoon('Start planning');
  const later = Date.now() + 91_000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(later);
  await clickSoon('Start the task');
  now.mockRestore();
}

/** Six retell turns: 90, 90, 60, 60, 45, 45 seconds. */
async function runRetell(seen: string[]) {
  for (let i = 0; i < 6; i++) {
    seen.push((await screen.findByText(/4\/3\/2 retell · round/)).textContent ?? '');
    await clickSoon(/^Start \d+ s$/);
    await clickSoon(i === 5 ? /Finished early|Done/ : /Finished early|Next turn/);
  }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetQuizzes();
  resetLiveInvites();
  // The AI helper's availability is asked once per app session.
  resetAiAvailability();
  mocks.status = 'offline';
  mocks.presence = undefined;
  mocks.aiEnabled = false;
  mocks.recognition = false;
  // Listeners remove themselves on unmount; the invite store's own listener lives as long as the app.
  mocks.buildQuizPool.mockResolvedValue(ITEMS);
  mocks.getQuizzes.mockRejectedValue(new Error('offline'));
  await updateSettings({ name: 'Aiko', deviceToken: 'token', memberId: 'me' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ---- Tests ----------------------------------------------------------------------------

describe('Session A on one phone, offline', () => {
  it('grades the owner’s pool on this phone, keeps the partner direction practice only, and credits the session', async () => {
    mocks.plan = weekPlan({ conversation: { scriptId: 'rp-u01', stage: 2 } });
    renderSession('A');

    expect(await screen.findByRole('heading', { name: 'Session A · Quiz & conversation' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Two phones' })).toHaveProperty('disabled', true);
    click('Start');

    // The rules card on the first step, the first three times.
    expect(await screen.findByText('Together rules')).toBeTruthy();

    // Ken asks Aiko from her own pool, on her phone.
    expect(await screen.findByText(/Hand the phone to Ken/)).toBeTruthy();
    expect(screen.getByText('Write the kanji for "water" · □ みず')).toBeTruthy();
    click('Right');
    // A double tap on the last verdict applies the verdicts once and moves on once.
    const last = await screen.findByRole('button', { name: 'Not yet' });
    act(() => { last.click(); last.click(); });
    await waitFor(() => expect(mocks.applyLocalVerdicts).toHaveBeenCalledWith(expect.stringMatching(/^local-/), ITEMS, [
      { key: 'kanji:水|write', verdict: 'right' },
      { key: 'core:cw-1|produce', verdict: 'wrong' },
    ]));

    // Ken's direction: no quiz of his on this phone, so his recent kanji, for practice only.
    expect(await screen.findByText(/Practice round/)).toBeTruthy();
    expect(screen.getByText('Write the kanji for "tree"')).toBeTruthy();
    click('Right');
    expect(mocks.applyLocalVerdicts).toHaveBeenCalledTimes(1);
    expect(mocks.submitQuizResult).not.toHaveBeenCalled();

    // Teach-me: Aiko's kanji, then Ken's.
    expect(await screen.findByRole('heading', { name: 'Explain it to Ken' })).toBeTruthy();
    expect(mocks.teachMeKanji).toHaveBeenCalled();
    click('Done');
    expect(await screen.findByText("Teach me · Ken's turn")).toBeTruthy();
    click('Done');

    // The core conversation at S2: Japanese only, the English behind a tap.
    expect(await screen.findByText(/Hello again · S2 Perform from the Japanese · line 1 of 2/)).toBeTruthy();
    expect(screen.queryByText('Sushi, please.')).toBeNull();
    click('Show English');
    expect(screen.getByText('Sushi, please.')).toBeTruthy();
    click('Next');
    await clickSoon('Finish');
    await clickSoon('Smooth for both of us');
    expect(events()).toContainEqual({ type: 'smooth', scriptId: 'rp-u01', stage: 2, both: true });
    click('Continue');

    expect(await screen.findByRole('heading', { name: 'Session done' })).toBeTruthy();
    await waitFor(() => expect(mocks.creditTogetherSession).toHaveBeenCalledWith('A', 1, dayKey()));
    expect(events()).toContainEqual({ type: 'session-done', session: 'A', date: dayKey(), minutes: 1 });
    expect(events().filter((e) => e.type === 'session-done')).toHaveLength(1);
  });
});

describe('Session A on two phones', () => {
  it('follows the opener’s plan, merges both quiz ids and posts the asker’s verdicts', async () => {
    mocks.status = 'online';
    mocks.presence = true;
    // This phone's own week would run another script and stage.
    mocks.plan = weekPlan({ conversation: { scriptId: 'rp-u02', stage: 1 }, storyId: 'st-1' });
    const kensQuiz: Quiz = { id: 'q-ken', kind: 'partner', fromMemberId: 'ken', toMemberId: 'me', createdAt: '2026-10-15T10:00:00Z', items: [ITEMS[1]] };
    mocks.getQuizzes.mockResolvedValue({ inbox: [kensQuiz], sent: [] });
    mocks.createQuiz.mockImplementation(async (req) => ({ ...req, id: 'q-me', fromMemberId: 'me', createdAt: 'now' }));
    mocks.submitQuizResult.mockImplementation(async (id: string, r) => ({ ...kensQuiz, id, result: { ...r, finishedAt: 'now' } }));
    renderSession('A');

    const kens: TogetherLiveState = {
      sessionId: 's-ken', session: 'A', opener: 'ken', plan: { conversation: { scriptId: 'rp-u01', stage: 3 } },
      quizIds: { ken: 'q-ken' }, step: 'quiz', index: 0, turn: 'ken', status: 'waiting',
    };
    await screen.findByRole('heading', { name: 'Session A · Quiz & conversation' });
    emit('ken', kens);
    await clickSoon('Join Ken');

    // Ken answers first: this phone asks his quiz.
    expect(await screen.findByText(/You ask Ken · 1 of 1/)).toBeTruthy();
    await waitFor(() => expect(mocks.createQuiz).toHaveBeenCalledWith({ toMemberId: 'ken', kind: 'partner', items: ITEMS }));
    await waitFor(() => {
      const last = mocks.sendLive.mock.calls.at(-1)![0];
      expect(last.quizIds).toEqual({ ken: 'q-ken', me: 'q-me' });
      // The joiner never sends a plan of its own.
      expect(last.plan).toBeUndefined();
    });

    click('Right');
    await waitFor(() => expect(mocks.submitQuizResult).toHaveBeenCalledWith('q-ken', {
      correct: 1, total: 1, missed: [], verdicts: [{ key: 'core:cw-1|produce', verdict: 'right' }],
    }));
    // Then this phone answers: never the answers.
    expect(await screen.findByRole('heading', { name: 'Your turn: answer out loud or write' })).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
    // Ken's phone repeats its state from before it heard the hand-over: this phone keeps its turn.
    emit('ken', { ...kens, status: 'active', quizIds: { ken: 'q-ken', me: 'q-me' } });
    expect(screen.getByRole('heading', { name: 'Your turn: answer out loud or write' })).toBeTruthy();
    expect(screen.queryByText(/You ask Ken/)).toBeNull();

    // Teach-me: Ken explains first; this phone hands the turn over, and Ken's older state doesn't take it back.
    emit('ken', { ...kens, step: 'teach-me', index: 0, turn: 'ken', status: 'active', quizIds: { ken: 'q-ken', me: 'q-me' } });
    await clickSoon('They explained it');
    expect(await screen.findByRole('heading', { name: 'Explain it to Ken' })).toBeTruthy();
    expect(mocks.sendLive.mock.calls.at(-1)![0]).toMatchObject({ step: 'teach-me', turn: 'me', index: 0 });
    emit('ken', { ...kens, step: 'teach-me', index: 0, turn: 'ken', status: 'active', quizIds: { ken: 'q-ken', me: 'q-me' } });
    expect(screen.getByRole('heading', { name: 'Explain it to Ken' })).toBeTruthy();

    // The opener moves on to the conversation: its script and stage, not this phone's.
    emit('ken', { ...kens, step: 'conversation', index: 0, status: 'active', quizIds: { ken: 'q-ken', me: 'q-me' } });
    expect(await screen.findByText(/Hello again · S3 Swap roles/)).toBeTruthy();
    expect(screen.queryByText(/Weekend plans/)).toBeNull();
  });
});

describe('Session B', () => {
  it('runs the scripted task without the AI, from the task targets, and posts task-done', async () => {
    mocks.plan = weekPlan({ task: { unit: 1, taskId: 'u01-task', repeat: true } });
    renderSession('B');
    await clickSoon('Start');

    expect(await screen.findByRole('heading', { name: 'Order lunch for both of you' })).toBeTruthy();
    expect(screen.getByText(/Twist:/).parentElement?.textContent).toContain('The café is out of sushi.');
    expect(screen.getByText('Can-do · Order food')).toBeTruthy();
    await waitFor(() => expect(mocks.taskTargets).toHaveBeenCalledWith(TASK.targets, ['core:cw-1'], ['core:cw-2']));
    expect(await screen.findByText('sushi')).toBeTruthy();
    expect(screen.getByText('(one of yours)', { exact: false })).toBeTruthy();
    // One phone: each half behind its own tap.
    click('Partner A only');
    expect(screen.getByText('You want sushi.')).toBeTruthy();
    // A double tap moves on one step, not two: the planning timer is not skipped.
    const plan = screen.getByRole('button', { name: 'Plan in silence' });
    act(() => { plan.click(); plan.click(); });

    await passPlanning();
    // No AI: the scripted version, read in roles.
    expect(await screen.findByText(/Scripted version · line 1 of 2/)).toBeTruthy();
    click('Next');
    click('Next');
    await clickSoon('Swap roles');
    click('Next');
    click('Next');
    await clickSoon('Done');
    await clickSoon('We answered it');
    expect(await screen.findByText(/The recap needs the home server's AI/)).toBeTruthy();
    click('Finish the task');
    expect(events()).toContainEqual({ type: 'task-done', taskId: 'u01-task', date: dayKey(), repeat: true });
    expect(mocks.aiRolePlay).not.toHaveBeenCalled();
    expect(mocks.createGuardedCloze).not.toHaveBeenCalled();
    await waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ type: 'session-done', session: 'B' })));
  });

  it('lets the AI play the third role and turns recap points into cards only through the guard', async () => {
    mocks.status = 'online';
    mocks.presence = false;
    mocks.aiEnabled = true;
    mocks.plan = weekPlan({ task: { unit: 1, taskId: 'u01-task', repeat: false } });
    mocks.aiRolePlay.mockResolvedValue({ reply: 'いらっしゃいませ', en: 'Welcome', done: false });
    mocks.aiRecap.mockResolvedValue({
      praise: 'Clear and polite.',
      points: [
        { quote: 'すしを ください', corrected: 'すしを ください。', rule: 'End with 。', grammarUsed: [], words: [] },
        { quote: 'みず', corrected: 'おみずを ください。', rule: 'Ask politely.', grammarUsed: ['other'], words: [] },
      ],
    });
    mocks.createGuardedCloze.mockResolvedValueOnce('card-1').mockResolvedValueOnce(null);
    renderSession('B');
    await clickSoon('Start');
    await clickSoon('Plan in silence');
    await passPlanning();

    expect(await screen.findByText('いらっしゃいませ')).toBeTruthy();
    await waitFor(() => expect(mocks.play).toHaveBeenCalledWith({ text: 'いらっしゃいませ', voice: 'm' }));
    fireEvent.change(screen.getByLabelText('What you said'), { target: { value: 'すしを ください' } });
    click('Say it');
    await waitFor(() => expect(mocks.aiRolePlay).toHaveBeenCalledTimes(2));
    expect(mocks.aiRolePlay.mock.calls[1][0]).toMatchObject({
      taskId: 'u01-task', aiRole: 'clerk', goal: TASK.goal, knownGrammar: ['wa-desu'],
      history: [{ speaker: 'ai', text: 'いらっしゃいませ' }, { speaker: 'a', text: 'すしを ください' }],
    });
    await clickSoon('Swap roles');

    // After the swap Ken has role A. His line said out loud: speech recognition fills it in, then
    // it goes as his, so it stays out of this phone's private recap.
    mocks.recognition = true;
    mocks.heard = 'みずを ください';
    expect(await screen.findByRole('button', { name: 'Speaking: Ken. Tap to switch' })).toBeTruthy();
    await clickSoon('Say your line');
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('What you said').value).toBe('みずを ください'));
    click('Say it');
    await waitFor(() => expect(mocks.aiRolePlay).toHaveBeenCalledTimes(4));
    expect(mocks.aiRolePlay.mock.calls[3][0].history.at(-1)).toEqual({ speaker: 'a', text: 'みずを ください' });
    await clickSoon('Done');
    await clickSoon('We answered it');

    expect(await screen.findByText('One sentence added to your reviews.')).toBeTruthy();
    expect(mocks.aiRecap).toHaveBeenCalledWith(expect.objectContaining({ goal: TASK.goal, lines: ['すしを ください'] }));
    expect(mocks.createGuardedCloze).toHaveBeenCalledTimes(2);
    expect(mocks.createGuardedCloze).toHaveBeenCalledWith({ corrected: 'すしを ください。', en: '', words: [], grammarUsed: [] }, 'recap');
    expect(screen.getByText(/Only you can see this/)).toBeTruthy();
  });

  it('runs a free role-play at stage 1 when there is no task, and never marks a stage', async () => {
    mocks.plan = weekPlan({ rolePlayId: 'rp-free' });
    renderSession('B');
    await clickSoon('Start');
    expect(await screen.findByText(/At the café · S1 Listen and shadow · line 1 of 2/)).toBeTruthy();
    // S1 shows the English and plays the model audio, two voices.
    expect(screen.getByText('Sushi, please.')).toBeTruthy();
    click('Play');
    expect(mocks.play).toHaveBeenCalledWith({ ref: 'rp:rp-free#0' }, { voice: 'f', fallbackText: 'すしを ください。' });
    click('Next');
    await clickSoon('Finish');
    // Then read it in roles, with the English shown.
    expect(await screen.findByRole('heading', { name: 'Now read it in roles' })).toBeTruthy();
    click('Read it in roles');
    expect(await screen.findByText(/At the café · Read in roles · line 1 of 2/)).toBeTruthy();
    expect(screen.getByText('Sushi, please.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show English' })).toBeNull();
    click('Next');
    await clickSoon('Finish');
    expect(await screen.findByRole('heading', { name: 'Nicely done' })).toBeTruthy();
    // Again, with roles swapped: the run counts forward (both phones only move forward).
    click('Again, roles swapped');
    expect(await screen.findByText(/At the café · Read in roles, swapped · line 1 of 2/)).toBeTruthy();
    click('Next');
    await clickSoon('Finish');
    click('Continue');
    await screen.findByRole('heading', { name: 'Session done' });
    expect(events().some((e) => e.type === 'smooth')).toBe(false);
  });
});

describe('Session C', () => {
  it('runs the retell at 90, 60 and 45 seconds and posts a dictation quiz on two phones', async () => {
    mocks.status = 'online';
    mocks.presence = true;
    mocks.plan = weekPlan({ storyId: 'st-1' });
    mocks.createQuiz.mockImplementation(async (req) => ({ ...req, id: 'q-dict', fromMemberId: 'me', createdAt: 'now' }));
    renderSession('C');
    await clickSoon('Start together');
    expect(await screen.findByRole('heading', { name: 'Waiting for Ken…' })).toBeTruthy();
    const mine = mocks.sendLive.mock.calls[0][0];
    expect(mine).toMatchObject({ opener: 'me', status: 'waiting', plan: { storyId: 'st-1' } });
    emit('ken', { ...mine, plan: undefined, status: 'active' });

    expect(await screen.findByRole('heading', { name: 'The cat next door' })).toBeTruthy();
    click('On to the retell');
    const seen: string[] = [];
    await runRetell(seen);
    expect(seen.map((s) => /(\d+) s$/.exec(s)?.[1])).toEqual(['90', '90', '60', '60', '45', '45']);

    expect(await screen.findByText('Partner dictation')).toBeTruthy();
    await waitFor(() => expect(mocks.createQuiz).toHaveBeenCalledWith({ toMemberId: 'ken', kind: 'dictation', items: ITEMS }));
    expect(mocks.buildQuizPool).toHaveBeenCalledWith('dictation');
  });

  it('keeps this phone’s check-in open on two phones when the partner’s phone finished first', async () => {
    mocks.status = 'online';
    mocks.presence = true;
    mocks.plan = weekPlan({ storyId: 'st-1' });
    renderSession('C');
    const kens: TogetherLiveState = {
      sessionId: 's-ken', session: 'C', opener: 'ken', plan: { storyId: 'st-1' },
      quizIds: {}, step: 'story', index: 0, turn: 'ken', status: 'waiting',
    };
    await screen.findByRole('heading', { name: 'Session C · Story, game & check-in' });
    emit('ken', kens);
    await clickSoon('Join Ken');
    expect(await screen.findByRole('heading', { name: 'The cat next door' })).toBeTruthy();

    // Ken's phone reaches the check-in, saves Ken's and finishes.
    emit('ken', { ...kens, step: 'checkin', status: 'active' });
    expect(await screen.findByRole('heading', { name: 'Weekly check-in' })).toBeTruthy();
    emit('ken', { ...kens, step: 'done', status: 'done' });
    // This phone keeps its own check-in until it is saved here.
    expect(screen.getByRole('heading', { name: 'Weekly check-in' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Session done' })).toBeNull();
    await screen.findByText('Minutes');
    click('Save the check-in');

    expect(await screen.findByRole('heading', { name: 'Session done' })).toBeTruthy();
    expect(events()).toContainEqual({ type: 'checkin', checkin: { counts: { kanji: 3, words: 12, grammar: 1, minutes: 95 } } });
    await waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ type: 'session-done', session: 'C' })));
  });

  it('starts the check-in from the couple’s own slots when the together state has none', async () => {
    const own = [
      { session: 'A', weekday: 1, time: '19:00' },
      { session: 'B', weekday: 3, time: '19:00' },
      { session: 'C', weekday: 6, time: '10:00' },
    ] as const;
    await updateSettings({ togetherSlots: [...own] });
    mocks.status = 'online';
    mocks.presence = true;
    mocks.plan = weekPlan({});
    renderSession('C');
    await screen.findByRole('heading', { name: 'Session C · Story, game & check-in' });
    const kens: TogetherLiveState = {
      sessionId: 's-ken', session: 'C', opener: 'ken', plan: {}, quizIds: {}, step: 'checkin', index: 0, turn: 'ken', status: 'active',
    };
    emit('ken', kens);
    await clickSoon('Join Ken');
    expect(await screen.findByRole('heading', { name: 'Weekly check-in' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Session A day').value).toBe('1');
    expect(screen.getByLabelText<HTMLInputElement>('Session C time').value).toBe('10:00');
    await screen.findByText('Minutes');
    click('Save the check-in');
    expect(await screen.findByRole('heading', { name: 'Session done' })).toBeTruthy();
    // Unchanged: nothing is posted over the couple's slots.
    expect(events().some((e) => e.type === 'slots')).toBe(false);
  });

  it('runs the season showcase instead of the dictation, then the check-in', async () => {
    mocks.plan = weekPlan({ showcase: true });
    renderSession('C');
    await clickSoon('Start');
    await runRetell([]);
    expect(await screen.findByText('Season showcase')).toBeTruthy();
    expect(screen.queryByText('Partner dictation')).toBeNull();
    // The check runs again in showcase mode: a rehearsal that records nothing.
    await clickSoon(/Order food/);
    expect(screen.getByText('Check: Order food (showcase)')).toBeTruthy();
    click('Back to the showcase');
    expect(mocks.recordCanDoAttempt).not.toHaveBeenCalled();
    click('On to the check-in');
    expect(await screen.findByRole('heading', { name: 'Weekly check-in' })).toBeTruthy();
  });
});

describe('Weekly check-in', () => {
  it('saves the counts, a ticked can-do, new slots and planned rest, and never records the can-do', async () => {
    const onSaved = vi.fn();
    render(<CheckIn week="2026-10-12" units={UNITS} settledUnit={1} slots={[]} onSaved={onSaved} />);
    expect((await screen.findByText('Minutes')).nextSibling?.textContent).toBe('95');
    fireEvent.change(screen.getByLabelText('Can-do you managed'), { target: { value: 'u01-cd1' } });
    fireEvent.change(screen.getByLabelText('Session A day'), { target: { value: '3' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    click('Save the check-in');

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.spendRestToken).toHaveBeenCalledWith('2026-10-19');
    expect(events()).toContainEqual({
      type: 'checkin',
      checkin: { counts: { kanji: 3, words: 12, grammar: 1, minutes: 95 }, canDo: 'u01-cd1', plannedRest: ['2026-10-19'] },
    });
    expect(events()).toContainEqual({
      type: 'slots',
      slots: [
        { session: 'A', weekday: 3, time: '20:00' },
        { session: 'B', weekday: 4, time: '20:00' },
        { session: 'C', weekday: 7, time: '19:30' },
      ],
    });
    expect(mocks.recordCanDoAttempt).not.toHaveBeenCalled();
  });

  it('posts no slots when the form was left as it opened, even if the partner changed them meanwhile', async () => {
    const onSaved = vi.fn();
    const ours: TogetherSlot[] = [
      { session: 'A', weekday: 2, time: '20:00' },
      { session: 'B', weekday: 4, time: '20:00' },
      { session: 'C', weekday: 7, time: '19:30' },
    ];
    const view = render(<CheckIn week="2026-10-12" units={UNITS} settledUnit={1} slots={ours} onSaved={onSaved} />);
    await screen.findByText('Minutes');
    // The partner's check-in moved Session A to Wednesday while this form was open.
    view.rerender(<CheckIn week="2026-10-12" units={UNITS} settledUnit={1} slots={[{ ...ours[0], weekday: 3 }, ours[1], ours[2]]} onSaved={onSaved} />);
    click('Save the check-in');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(events().some((e) => e.type === 'slots')).toBe(false);

    // A household with no slots yet takes this phone's own, unchanged.
    cleanup();
    render(<CheckIn week="2026-10-12" units={UNITS} settledUnit={1} slots={ours} shared={false} onSaved={onSaved} />);
    await screen.findByText('Minutes');
    click('Save the check-in');
    await waitFor(() => expect(events()).toContainEqual({ type: 'slots', slots: ours }));
  });
});

describe('Monthly session', () => {
  it('runs the monthly quiz, the goal and the capstone, and posts monthly', async () => {
    mocks.plan = weekPlan({ monthly: true, capstoneUnit: 1, sessions: [{ id: 'monthly', day: '2026-11-07', time: '10:00' }] });
    mocks.buildQuizPool.mockResolvedValue([ITEMS[0]]);
    renderSession('monthly');
    expect(await screen.findByRole('heading', { name: 'Monthly session' })).toBeTruthy();
    click('Start');

    expect(await screen.findByText('Monthly quiz')).toBeTruthy();
    await clickSoon('Right');
    await waitFor(() => expect(mocks.applyLocalVerdicts).toHaveBeenCalled());
    expect(mocks.buildQuizPool).toHaveBeenCalledWith('monthly');
    // Ken's direction: his recent kanji, practice only.
    await clickSoon('Right');

    expect(await screen.findByRole('heading', { name: "New month, fresh start: what's our goal for November?" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Our goal'), { target: { value: 'Order a whole dinner in Japanese' } });
    click('Set our goal');

    expect(await screen.findByRole('heading', { name: 'Lunch date' })).toBeTruthy();
    expect(events()).toContainEqual({ type: 'goal', goal: { text: 'Order a whole dinner in Japanese', targetDate: '2026-11-30' } });
    fireEvent.change(screen.getByLabelText('Next line'), { target: { value: 'すしが すき' } });
    click('Add');
    click('Perform it');
    await clickSoon('We performed it');

    expect(await screen.findByRole('heading', { name: 'Session done' })).toBeTruthy();
    expect(events()).toContainEqual({ type: 'capstone-done', unit: 1, date: dayKey() });
    await waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ type: 'session-done', session: 'monthly' })));
    expect(mocks.creditTogetherSession).toHaveBeenCalledWith('monthly', expect.any(Number), dayKey());
  });
});
