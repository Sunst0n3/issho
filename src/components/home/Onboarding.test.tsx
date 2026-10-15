import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TogetherState } from '../../../shared/api.ts';
import { dayKey, getSettings, updateSettings } from '../../lib/db.ts';
import type { KanaEntry, KanaScript } from '../../lib/types.ts';
import Onboarding from '../../screens/Onboarding.tsx';
import { shiftDay } from './labels.ts';
import { reminderSeed } from './RemindersStep.tsx';
import { KANA, renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

const mocks = vi.hoisted(() => ({
  applyPlacement: vi.fn(async (_script: string, correct: number) => (correct >= 18 ? 'known' as const : 'sprint' as const)),
  requestPersistentStorage: vi.fn(async () => true),
  downloadIcs: vi.fn(),
  postTogetherEvent: vi.fn(async () => {}),
  getTogether: vi.fn(),
  play: vi.fn(async () => ({ via: 'clip', ms: 300, interrupted: false })),
  together: { state: null as TogetherState | null },
}));

vi.mock('../../srs/course.ts', () => ({
  PLACEMENT_ITEMS: 20,
  PLACEMENT_PASS: 18,
  // 20 kana of the script (the fixtures have 5 per script: repeated, as the check only needs 20 prompts).
  placementSet: (kana: readonly KanaEntry[], script: KanaScript) => {
    const own = kana.filter((k) => k.script === script && k.kind === 'basic');
    return Array.from({ length: 20 }, (_, i) => own[i % own.length]);
  },
  applyPlacement: mocks.applyPlacement,
}));
vi.mock('../../lib/backup.ts', () => ({ requestPersistentStorage: mocks.requestPersistentStorage }));
vi.mock('../../lib/ics.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/ics.ts')>()),
  downloadIcs: mocks.downloadIcs,
}));
vi.mock('../../speech/audio.ts', () => ({ play: mocks.play }));
vi.mock('../../sync/together.ts', () => ({
  postTogetherEvent: mocks.postTogetherEvent,
  useTogetherState: () => ({ state: mocks.together.state, offline: false, refresh: async () => {} }),
}));
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  getTogether: mocks.getTogether,
}));
// The recall pad: buttons stand in for writing the kana right or wrong, or right after its Hint.
vi.mock('../../writing/index.ts', () => ({
  useStrokes: () => ({ strokes: ['M10 10 L90 90'], loading: false }),
  WritingPad: ({ onRecallDone, mode }: { mode: string; onRecallDone?: (r: { match: { ok: boolean }; hintUsed: boolean }) => void }) => (
    <div data-mode={mode}>
      <button type="button" onClick={() => onRecallDone?.({ match: { ok: true }, hintUsed: false })}>Write it right</button>
      <button type="button" onClick={() => onRecallDone?.({ match: { ok: false }, hintUsed: false })}>Write it wrong</button>
      <button type="button" onClick={() => onRecallDone?.({ match: { ok: true }, hintUsed: true })}>Write it after a hint</button>
    </div>
  ),
}));
// The real form pairs with the home server; here it only needs its two ways out.
vi.mock('../together/ConnectServerForm.tsx', () => ({
  ConnectServerForm: ({ onConnected, onSkip }: { onConnected(): void; onSkip?(): void }) => (
    <div>
      <button type="button" onClick={onConnected}>Connect</button>
      <button type="button" onClick={onSkip}>Not now</button>
    </div>
  ),
}));

beforeEach(async () => {
  await resetDb();
  mocks.together.state = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

async function throughName(name = 'Sam') {
  fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: name } });
  next();
  await screen.findByRole('heading', { name: 'How long each day?' });
}

/** Answers the placement check: `right` of the 20 correct. */
async function answerPlacement(right: number) {
  fireEvent.click(await screen.findByRole('button', { name: 'Start the check' }));
  for (let i = 0; i < 20; i++) {
    await screen.findByText(`Kana ${i + 1} of 20`);
    // Written from memory on the recall pad: no model, no per-stroke marks.
    expect(document.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('recall');
    fireEvent.click(screen.getByRole('button', { name: i < right ? 'Write it right' : 'Write it wrong' }));
  }
}

/** Onboarding with the browser's own Back (the phone's back gesture) next to it. */
function renderWithHistory(path: string) {
  function BrowserBack() {
    const navigate = useNavigate();
    const { pathname, search } = useLocation();
    return <button type="button" data-at={pathname + search} onClick={() => navigate(-1)}>Browser back</button>;
  }
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/welcome" element={<Onboarding />} />
        <Route path="/" element={<p>Home screen</p>} />
      </Routes>
      <BrowserBack />
    </MemoryRouter>,
  );
}
const browserBack = () => fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
const at = () => screen.getByRole('button', { name: 'Browser back' }).getAttribute('data-at');

describe('Onboarding', () => {
  it('walks through every step and saves the plan', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    expect(await screen.findByRole('heading', { name: 'Japanese, together' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 8')).toBeTruthy();
    await throughName('  Sam ');

    // Minutes: 25 is the default, with the simulated notes.
    expect((screen.getByRole('radio', { name: /25 min a day/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/about 270–310 kanji, 1,550 words in a year/)).toBeTruthy();
    expect(screen.getByText(/about 165–175 kanji, 1,300 words in a year/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /30 min a day/ }));
    next();

    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    next();

    await screen.findByRole('heading', { name: 'When will you study?' });
    fireEvent.change(screen.getByLabelText('After I'), { target: { value: 'pour my evening tea' } });
    fireEvent.change(screen.getByLabelText('at'), { target: { value: 'the kitchen table' } });
    fireEvent.change(screen.getByLabelText('Remind me at'), { target: { value: '21:15' } });
    fireEvent.change(screen.getByLabelText('If I miss it…'), { target: { value: 'I do 3 minutes before brushing my teeth' } });
    next();

    await screen.findByRole('heading', { name: 'Time together' });
    // Tuesday, Thursday and Sunday at 20:00 to start with.
    expect((screen.getByLabelText('Session A day') as HTMLSelectElement).value).toBe('2');
    expect((screen.getByLabelText('Session B day') as HTMLSelectElement).value).toBe('4');
    expect((screen.getByLabelText('Session C day') as HTMLSelectElement).value).toBe('7');
    expect((screen.getByLabelText('Session A time') as HTMLInputElement).value).toBe('20:00');
    fireEvent.change(screen.getByLabelText('Session C time'), { target: { value: '19:30' } });
    fireEvent.change(screen.getByLabelText('Our shared goal'), { target: { value: 'Order dinner in Kyoto' } });
    fireEvent.change(screen.getByLabelText('By'), { target: { value: '2027-04-01' } });
    expect(screen.getByRole('heading', { name: 'How we practise together' })).toBeTruthy();
    next();

    await screen.findByRole('heading', { name: 'Reminders' });
    expect(await getSettings()).toMatchObject({
      name: 'Sam',
      dailyMinutes: 30,
      cue: { text: 'After I pour my evening tea at the kitchen table, I open Issho', time: '21:15' },
      coping: 'I do 3 minutes before brushing my teeth',
      togetherSlots: [
        { session: 'A', weekday: 2, time: '20:00' },
        { session: 'B', weekday: 4, time: '20:00' },
        { session: 'C', weekday: 7, time: '19:30' },
      ],
      sharedGoal: { text: 'Order dinner in Kyoto', targetDate: '2027-04-01' },
    });
    // Not paired: nothing is posted to a household.
    expect(mocks.postTogetherEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(mocks.downloadIcs).toHaveBeenCalledTimes(1);
    const ics = (mocks.downloadIcs.mock.calls[0] as unknown as [string])[0];
    expect(ics).toContain('RRULE:FREQ=DAILY');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU');
    expect(ics).toContain('T193000');
    next();

    await screen.findByRole('heading', { name: 'Study together' });
    expect(screen.getByText('Step 8 of 8')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(await screen.findByText('Home screen')).toBeTruthy();
    const today = dayKey();
    // Plan reviews in course weeks 4 and 8.
    expect(await getSettings()).toMatchObject({ onboarded: true, planReviewDays: [shiftDay(today, 28), shiftDay(today, 56)] });
    expect(mocks.applyPlacement).not.toHaveBeenCalled();
    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it('places a learner past hiragana with 18 of 20, and plays each sound', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    await throughName();
    next();
    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    fireEvent.click(screen.getByRole('switch', { name: /I know hiragana/ }));
    next();

    await screen.findByRole('heading', { name: 'Check your hiragana' });
    await answerPlacement(18);
    expect(await screen.findByRole('heading', { name: "18/20 — you're past hiragana" })).toBeTruthy();
    expect(mocks.applyPlacement).toHaveBeenCalledTimes(1);
    expect(mocks.applyPlacement).toHaveBeenCalledWith('hiragana', 18);
    expect(mocks.play).toHaveBeenCalledWith({ ref: `kana:${KANA[0].char}` }, expect.anything());
    next();
    expect(await screen.findByRole('heading', { name: 'When will you study?' })).toBeTruthy();
  });

  it('sends a learner with 17 of 20 to the sprint', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    await throughName();
    next();
    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    fireEvent.click(screen.getByRole('switch', { name: /I know katakana/ }));
    next();
    await screen.findByRole('heading', { name: 'Check your katakana' });
    await answerPlacement(17);
    expect(await screen.findByRole('heading', { name: "17/20 — let's do the 14-day sprint" })).toBeTruthy();
    expect(mocks.applyPlacement).toHaveBeenCalledWith('katakana', 17);
  });

  it("doesn't count a kana written after the pad's hint showed its strokes", async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    await throughName();
    next();
    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    fireEvent.click(screen.getByRole('switch', { name: /I know hiragana/ }));
    next();
    fireEvent.click(await screen.findByRole('button', { name: 'Start the check' }));
    for (let i = 0; i < 20; i++) {
      await screen.findByText(`Kana ${i + 1} of 20`);
      // 17 from memory, 3 copied from the hint: 17, not 20.
      fireEvent.click(screen.getByRole('button', { name: i < 3 ? 'Write it after a hint' : 'Write it right' }));
    }
    expect(await screen.findByRole('heading', { name: "17/20 — let's do the 14-day sprint" })).toBeTruthy();
    expect(mocks.applyPlacement).toHaveBeenCalledWith('hiragana', 17);
  });

  it('counts a sprint of 7 days when the other script was passed in an earlier run', async () => {
    await updateSettings({ name: 'Sam', knowsHiragana: true });
    renderAt('/welcome?step=kana', '/welcome', <Onboarding />);
    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    expect(await screen.findByText("You're past hiragana already.")).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: /I know katakana/ }));
    next();
    await screen.findByRole('heading', { name: 'Check your katakana' });
    await answerPlacement(12);
    expect(await screen.findByRole('heading', { name: "12/20 — let's do the 7-day sprint" })).toBeTruthy();
  });

  it('checks both scripts in turn when both are known', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    await throughName();
    next();
    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    fireEvent.click(screen.getByRole('switch', { name: /I know hiragana/ }));
    fireEvent.click(screen.getByRole('switch', { name: /I know katakana/ }));
    next();
    await screen.findByRole('heading', { name: 'Check your hiragana' });
    await answerPlacement(20);
    await screen.findByRole('heading', { name: "20/20 — you're past hiragana" });
    next();
    await screen.findByRole('heading', { name: 'Check your katakana' });
    await answerPlacement(10);
    // Hiragana is known, so the sprint left is the 7-day katakana one.
    expect(await screen.findByRole('heading', { name: "10/20 — let's do the 7-day sprint" })).toBeTruthy();
    expect(mocks.applyPlacement.mock.calls).toEqual([['hiragana', 20], ['katakana', 10]]);
  });

  it('posts the slots and the goal when the phone is already paired (kept through the upgrade)', async () => {
    await updateSettings({ name: 'Sam', deviceToken: 'token', memberId: 'm-sam' });
    renderAt('/welcome?step=together', '/welcome', <Onboarding />);
    await screen.findByRole('heading', { name: 'Time together' });
    fireEvent.change(screen.getByLabelText('Our shared goal'), { target: { value: 'Read a menu in Osaka' } });
    fireEvent.change(screen.getByLabelText('By'), { target: { value: shiftDay(dayKey(), 90) } });
    next();
    await screen.findByRole('heading', { name: 'Reminders' });
    expect(mocks.postTogetherEvent).toHaveBeenCalledWith({
      type: 'slots',
      slots: [
        { session: 'A', weekday: 2, time: '20:00' },
        { session: 'B', weekday: 4, time: '20:00' },
        { session: 'C', weekday: 7, time: '20:00' },
      ],
    });
    expect(mocks.postTogetherEvent).toHaveBeenCalledWith({ type: 'goal', goal: { text: 'Read a menu in Osaka', targetDate: shiftDay(dayKey(), 90) } });
  });

  it("starts from the partner's slots when the household has them", async () => {
    await updateSettings({ name: 'Sam', deviceToken: 'token', memberId: 'm-sam' });
    mocks.together.state = {
      slots: [{ session: 'A', weekday: 1, time: '19:00' }, { session: 'B', weekday: 3, time: '19:00' }, { session: 'C', weekday: 6, time: '10:00' }],
      goal: { text: 'Kyoto trip', targetDate: '2027-04-01' }, stages: {}, smooth: {}, sessions: [], tasks: [], checkins: [], capstones: [],
    };
    renderAt('/welcome?step=together', '/welcome', <Onboarding />);
    await screen.findByRole('heading', { name: 'Time together' });
    await waitFor(() => expect((screen.getByLabelText('Session A day') as HTMLSelectElement).value).toBe('1'));
    expect(screen.getByText(/Your partner picked these/)).toBeTruthy();
    expect((screen.getByLabelText('Our shared goal') as HTMLInputElement).value).toBe('Kyoto trip');
  });

  it('finishes without pairing again when the phone kept its pairing', async () => {
    await updateSettings({ name: 'Sam', deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    mocks.getTogether.mockResolvedValue({ slots: [{ session: 'A', weekday: 1, time: '19:00' }], goal: null, stages: {}, smooth: {}, sessions: [], tasks: [], checkins: [], capstones: [] });
    renderAt('/welcome?step=connect', '/welcome', <Onboarding />);
    expect(await screen.findByText(/still connected to Our home/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start learning' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    // The partner set the slots first: this phone takes theirs and posts nothing.
    await waitFor(async () => expect((await getSettings()).togetherSlots).toEqual([{ session: 'A', weekday: 1, time: '19:00' }]));
    expect(mocks.postTogetherEvent).not.toHaveBeenCalled();
  });

  it('shares the plan with the household after pairing at the last step, unless the partner set one first', async () => {
    await updateSettings({ name: 'Sam', togetherSlots: [{ session: 'A', weekday: 2, time: '20:00' }] });
    mocks.getTogether.mockResolvedValue({ slots: [], goal: null, stages: {}, smooth: {}, sessions: [], tasks: [], checkins: [], capstones: [] });
    renderAt('/welcome?step=connect', '/welcome', <Onboarding />);
    await screen.findByRole('heading', { name: 'Study together' });
    // Pairing stores the token; the stand-in form only reports success.
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    await waitFor(() => expect(mocks.postTogetherEvent).toHaveBeenCalledWith({ type: 'slots', slots: [{ session: 'A', weekday: 2, time: '20:00' }] }));
  });

  it('starts from the saved answers when run again (after the v2 upgrade)', async () => {
    await updateSettings({ name: 'Sam', dailyMinutes: 20, cue: { text: 'After I get home at the door, I open Issho', time: '18:30' } });
    renderAt('/welcome', '/welcome', <Onboarding />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    expect(((await screen.findByLabelText('Your name')) as HTMLInputElement).value).toBe('Sam');
    next();
    await screen.findByRole('heading', { name: 'How long each day?' });
    expect((screen.getByRole('radio', { name: /20 min a day/ }) as HTMLInputElement).checked).toBe(true);
    next();
    await screen.findByRole('heading', { name: 'Do you already know kana?' });
    next();
    await screen.findByRole('heading', { name: 'When will you study?' });
    expect((screen.getByLabelText('After I') as HTMLInputElement).value).toBe('get home');
    expect((screen.getByLabelText('at') as HTMLInputElement).value).toBe('the door');
    expect((screen.getByLabelText('Remind me at') as HTMLInputElement).value).toBe('18:30');
  });

  it('puts each step in history, so the back gesture goes to the previous step', async () => {
    renderWithHistory('/welcome');
    await throughName('Kim');
    expect(at()).toBe('/welcome?step=minutes');
    browserBack();
    expect(((await screen.findByLabelText('Your name')) as HTMLInputElement).value).toBe('Kim');
    expect(at()).toBe('/welcome?step=name');
    browserBack();
    expect(await screen.findByRole('heading', { name: 'Japanese, together' })).toBeTruthy();
  });

  it('stays on the same step after a reload', async () => {
    await updateSettings({ name: 'Kim' });
    renderWithHistory('/welcome?step=habit');
    expect(await screen.findByRole('heading', { name: 'When will you study?' })).toBeTruthy();
    expect(screen.getByText('Step 5 of 8')).toBeTruthy();
  });

  it('asks for the name first when a later step is opened without one', async () => {
    renderWithHistory('/welcome?step=connect');
    expect(await screen.findByRole('heading', { name: 'What should we call you?' })).toBeTruthy();
    expect(at()).toBe('/welcome?step=name');
  });

  it('leaves no setup steps behind Today once finished', async () => {
    await updateSettings({ name: 'Kim' });
    renderWithHistory('/welcome?step=reminders');
    await screen.findByRole('heading', { name: 'Reminders' });
    next();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    expect(at()).toBe('/');
    browserBack();
    expect(screen.getByText('Home screen')).toBeTruthy();
  });

  it('goes back a step without losing answers', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    await throughName('Kim');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(((await screen.findByLabelText('Your name')) as HTMLInputElement).value).toBe('Kim');
  });

  it('keeps the reminder UIDs when the phone pairs after downloading them', () => {
    localStorage.removeItem('issho.ics.uid');
    // Onboarding offers the file before the connect step, so the first download is usually unpaired.
    const unpaired = reminderSeed(undefined);
    expect(unpaired).toBeTruthy();
    // Settings → Habits on the same phone once paired: the same seed, so the calendar updates its events.
    expect(reminderSeed('m-sam')).toBe(unpaired);
    // A phone that was paired before its first download starts from its member id.
    localStorage.removeItem('issho.ics.uid');
    expect(reminderSeed('m-sam')).toBe('m-sam');
    expect(reminderSeed(undefined)).toBe('m-sam');
    localStorage.removeItem('issho.ics.uid');
  });

  it('lists what the calendar file holds', async () => {
    await updateSettings({ name: 'Kim', cue: { text: 'After I wake up, I open Issho', time: '07:00' }, togetherSlots: [] });
    renderAt('/welcome?step=reminders', '/welcome', <Onboarding />);
    const list = (await screen.findByText('Every day at 07:00')).closest('ul')!;
    expect(within(list).getByText('Session A · Tuesdays at 20:00')).toBeTruthy();
  });
});
