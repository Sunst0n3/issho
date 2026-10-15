import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdResponse, MemberStats } from '../../../shared/api.ts';
import { dayKey, db, getSettings, updateSettings } from '../../lib/db.ts';
import Settings from '../../screens/Settings.tsx';
import { markAiBroken, resetAiAvailability } from '../together/ai.ts';
import { shiftDay } from './labels.ts';
import { resetNameSync } from './nameSync.ts';
import { RESET_TABLES } from './SettingsData.tsx';
import { cueDraft, cueFromDraft } from './planControls.tsx';
import { recheckSummary, voiceLabel, writeListAt, writeListStop } from './SettingsStudy.tsx';
import { addLearned, renderAt, resetDb } from './test-fixtures.tsx';

const server = vi.hoisted(() => ({
  renameMember: vi.fn(async (name: string) => ({ id: 'm-sam', name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null })),
  household: undefined as HouseholdResponse | undefined,
  aiEnabled: false,
}));

const mocks = vi.hoisted(() => ({
  syncWriteRetirement: vi.fn(async () => ({ retired: 2, restored: 0 })),
  applyPlacement: vi.fn(async () => 'known' as const),
  spendRestToken: vi.fn(async () => 'ok' as const),
  cancelPlannedToken: vi.fn(async () => {}),
  setTravel: vi.fn(async () => {}),
  postTogetherEvent: vi.fn(async () => {}),
  pushStats: vi.fn(async () => true),
  downloadIcs: vi.fn(),
  backup: { progressDropped: false },
  apply: vi.fn(async () => {}),
}));

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);
vi.mock('../together/ConnectServerForm.tsx', () => ({
  ConnectServerForm: () => <p>Pairing form</p>,
}));
vi.mock('../../srs/items.ts', () => ({ syncWriteRetirement: mocks.syncWriteRetirement, setPinned: vi.fn() }));
vi.mock('../../srs/course.ts', () => ({
  applyPlacement: mocks.applyPlacement,
  PLACEMENT_ITEMS: 20,
  PLACEMENT_PASS: 18,
  placementSet: () => [],
}));
vi.mock('../../srs/habits.ts', () => ({
  TOKENS_PER_WEEK: 2,
  TRAVEL_MAX_DAYS: 60,
  spendRestToken: mocks.spendRestToken,
  cancelPlannedToken: mocks.cancelPlannedToken,
  setTravel: mocks.setTravel,
}));
vi.mock('../../sync/together.ts', () => ({ postTogetherEvent: mocks.postTogetherEvent }));
vi.mock('../../lib/ics.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/ics.ts')>()),
  downloadIcs: mocks.downloadIcs,
}));
vi.mock('../../lib/backup.ts', () => {
  class BackupError extends Error {}
  return {
    BackupError,
    backupFileName: () => 'issho-backup.json',
    exportBackup: async () => new Blob(['{}']),
    importBackup: async () => ({
      exportedAt: new Date(2026, 3, 1),
      counts: { items: 3, reviewLogs: 10 },
      progressDropped: mocks.backup.progressDropped,
      apply: mocks.apply,
    }),
    requestPersistentStorage: async () => true,
  };
});
// The paired view asks the home server for its status; there is no server here.
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  health: async () => ({ ok: true as const, version: 'test', aiEnabled: server.aiEnabled, ttsEnabled: false }),
  renameMember: server.renameMember,
}));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({ data: server.household, loading: false, refresh: async () => {} }),
  refreshHousehold: async () => {},
  resetHousehold: () => {},
  pushStats: mocks.pushStats,
}));

beforeEach(async () => {
  await resetDb();
  await updateSettings({ onboarded: true, name: 'Sam' });
  await addLearned('日');
  await addLearned('水', { lapses: 2 });
  await db.days.put({
    date: dayKey(), studyMs: 1000, togetherMs: 0, reviews: 3, correct: 2, reviewMs: 0, strandMs: 0, newItems: 2,
    newSec: { sprint: 0, kanji: 0, staged: 0, core: 0, grammar: 0 }, minimumDone: true, goalMet: false, steps: [],
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  server.renameMember.mockClear();
  server.household = undefined;
  mocks.backup.progressDropped = false;
  resetNameSync();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function member(id: string, name: string): MemberStats {
  return {
    member: { id, name, joinedAt: '2026-09-01T00:00:00Z', lastSeenAt: null },
    days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1, progress: null, updatedAt: null,
  };
}

const section = async (name: string) => (await screen.findByRole('heading', { name })).closest('section')!;

async function openReset() {
  renderAt('/settings', '/settings', <Settings />);
  const data = await section('Data');
  fireEvent.click(within(data).getByRole('button', { name: 'Reset all progress' }));
  return data;
}

describe('Settings: study', () => {
  it('saves the daily minutes, with the simulated note', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const study = await section('Study');
    expect(within(study).getByText(/At 25 minutes: about 270–310 kanji/)).toBeTruthy();
    fireEvent.click(within(study).getByRole('radio', { name: '40 min' }));
    expect(within(study).getByText(/At 40 minutes: about 530 kanji, 2,400 words/)).toBeTruthy();
    await waitFor(async () => expect((await getSettings()).dailyMinutes).toBe(40));
  });

  it('calls syncWriteRetirement after a change to the handwriting list', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const study = await section('Study');
    const slider = within(study).getByLabelText('Handwriting list') as HTMLInputElement;
    // Stops of 50 kanji: 500 is stop 10.
    expect(slider.value).toBe('10');
    expect(slider.getAttribute('aria-valuetext')).toBe('500 kanji kept in handwriting');
    fireEvent.change(slider, { target: { value: '6' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('300 kanji kept in handwriting');
    await waitFor(() => expect(mocks.syncWriteRetirement).toHaveBeenCalledTimes(1));
    expect((await getSettings()).writeList).toBe(300);
    expect(await within(study).findByText('2 kanji now reading only.')).toBeTruthy();
  });

  it('lets the handwriting list run from 0 to all 2,136 kanji', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const study = await section('Study');
    const slider = within(study).getByLabelText('Handwriting list') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: slider.max } });
    expect(slider.getAttribute('aria-valuetext')).toBe('2,136 kanji kept in handwriting');
    await waitFor(async () => expect((await getSettings()).writeList).toBe(2136));
    expect(slider.value).toBe(slider.max);
    fireEvent.change(slider, { target: { value: slider.min } });
    await waitFor(async () => expect((await getSettings()).writeList).toBe(0));
  });

  it('maps the handwriting slider in steps of 50, with the whole list as its last stop', () => {
    expect([0, 1, 10, 42, 43].map(writeListAt)).toEqual([0, 50, 500, 2100, 2136]);
    expect([0, 50, 500, 2100, 2136].map(writeListStop)).toEqual([0, 1, 10, 42, 43]);
    expect(writeListAt(99)).toBe(2136);
  });

  it('shows the pinned count with the handwriting list', async () => {
    await db.items.update('kanji:日', { pinned: true });
    renderAt('/settings', '/settings', <Settings />);
    expect(await within(await section('Study')).findByText(/500 kanji kept in handwriting, plus 1 pinned/)).toBeTruthy();
  });

  it('offers exactly 85, 88, 90 and 93 % recall for reading and listening', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const study = await section('Study');
    const group = within(study).getByRole('radiogroup', { name: 'Recall target for reading and listening' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['85 %', '88 %', '90 %', '93 %']);
    expect(within(group).getByRole('radio', { checked: true }).textContent).toBe('90 %');
    fireEvent.click(within(group).getByRole('radio', { name: /88/ }));
    await waitFor(async () => expect((await getSettings()).receptiveRetention).toBe(0.88));
    expect(within(study).getByText(/Handwriting and production stay at 90/)).toBeTruthy();
  });

  it('has no new-per-day, review-cap or romaji controls', async () => {
    renderAt('/settings', '/settings', <Settings />);
    await section('Study');
    expect(screen.queryByText(/new items per day|most reviews|romaji/i)).toBeNull();
    expect(screen.queryByRole('switch', { name: /romaji/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /I already know/i })).toBeNull();
  });

  it('saves furigana, audio speed, hands-busy mode and the writing hand', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const study = await section('Study');
    fireEvent.click(within(study).getByRole('radio', { name: 'Never' }));
    fireEvent.click(within(study).getByRole('radio', { name: 'Slower' }));
    fireEvent.click(within(study).getByRole('switch', { name: 'Hands-busy mode' }));
    fireEvent.click(within(study).getByRole('radio', { name: 'Stylus' }));
    await waitFor(async () => expect(await getSettings()).toMatchObject({
      furigana: 'never', audioRate: 0.85, handsBusy: true, writingHand: 'stylus',
    }));
    fireEvent.click(within(study).getByRole('radio', { name: 'Auto' }));
    await waitFor(async () => expect((await getSettings()).audioRate).toBeUndefined());
  });

  it("words a re-check's result by what it changes, never promising a sprint", () => {
    const fail = { script: 'hiragana' as const, correct: 15, total: 20, outcome: 'sprint' as const };
    const pass = { script: 'katakana' as const, correct: 19, total: 20, outcome: 'known' as const };
    // Passed before, failed now: the kana stay in reviews.
    expect(recheckSummary(fail, true)).toEqual({ title: '15/20 — nothing changes', detail: 'Your hiragana stay in your reviews, which keep them fresh.' });
    // Never passed: the course carries on as planned (the learner may be mid-sprint or past it).
    expect(recheckSummary(fail, false).detail).toBe('The course teaches and reviews hiragana as planned.');
    expect(JSON.stringify(recheckSummary(fail, false))).not.toMatch(/sprint/);
    expect(recheckSummary(pass, false)).toEqual({
      title: "19/20 — you're past katakana",
      detail: 'Your katakana move into your reviews, and the course skips their lessons.',
    });
  });

  it('shortens voice names for the picker', () => {
    expect(voiceLabel('Flo (Japanese (Japan))')).toBe('Flo');
    expect(voiceLabel('Microsoft Nanami Online (Natural) - Japanese (Japan)')).toBe('Microsoft Nanami Online (Natural)');
    expect(voiceLabel('Kyoko')).toBe('Kyoko');
    expect(voiceLabel('Google 日本語')).toBe('Google 日本語');
  });
});

describe('Settings: habits', () => {
  it('saves the cue sentence, its time and the coping plan', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const habits = await section('Habits');
    fireEvent.change(within(habits).getByLabelText('After I'), { target: { value: 'brush my teeth' } });
    fireEvent.change(within(habits).getByLabelText('at'), { target: { value: 'the sink' } });
    fireEvent.change(within(habits).getByLabelText('Remind me at'), { target: { value: '22:00' } });
    fireEvent.change(within(habits).getByLabelText('If I miss it…'), { target: { value: '3 minutes on the train' } });
    await waitFor(async () => expect(await getSettings()).toMatchObject({
      cue: { text: 'After I brush my teeth at the sink, I open Issho', time: '22:00' },
      coping: '3 minutes on the train',
    }), { timeout: 2000 });
  });

  it('keeps the cue and the coping plan as typed when their tidied save comes back', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const habits = await section('Habits');
    const action = within(habits).getByLabelText('After I') as HTMLInputElement;
    const coping = within(habits).getByLabelText('If I miss it…') as HTMLInputElement;
    // No place, and a pause after a space: both are saved tidied up.
    fireEvent.change(action, { target: { value: 'brush my teeth' } });
    fireEvent.change(coping, { target: { value: '3 minutes ' } });
    await waitFor(async () => expect(await getSettings()).toMatchObject({
      cue: { text: 'After I brush my teeth, I open Issho', time: '20:00' },
      coping: '3 minutes',
    }), { timeout: 2000 });
    // The live settings have come back by now; the fields still hold what was typed.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(action.value).toBe('brush my teeth');
    expect((within(habits).getByLabelText('at') as HTMLInputElement).value).toBe('');
    expect(coping.value).toBe('3 minutes ');
    fireEvent.change(coping, { target: { value: '3 minutes on the train' } });
    await waitFor(async () => expect((await getSettings()).coping).toBe('3 minutes on the train'), { timeout: 2000 });
    expect((await getSettings()).cue?.text).toBe('After I brush my teeth, I open Issho');
  });

  it('still takes a cue changed elsewhere (a restored backup)', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const habits = await section('Habits');
    await act(() => updateSettings({ cue: { text: 'After I get home at the door, I open Issho', time: '18:30' } }));
    await waitFor(() => expect((within(habits).getByLabelText('After I') as HTMLInputElement).value).toBe('get home'));
    expect((within(habits).getByLabelText('at') as HTMLInputElement).value).toBe('the door');
    expect((within(habits).getByLabelText('Remind me at') as HTMLInputElement).value).toBe('18:30');
  });

  it('reads a saved cue back into its blanks, with or without a place', () => {
    const time = '07:00';
    expect(cueDraft({ text: 'After I brush my teeth, I open Issho', time })).toEqual({ action: 'brush my teeth', place: '', time });
    expect(cueDraft({ text: 'After I pour my tea at the kitchen table, I open Issho', time }))
      .toEqual({ action: 'pour my tea', place: 'the kitchen table', time });
    expect(cueDraft({ text: 'After I look at my phone at the desk, I open Issho', time }))
      .toEqual({ action: 'look at my phone', place: 'the desk', time });
    expect(cueDraft({ text: 'After I eat, wash up and sit down, I open Issho', time }))
      .toEqual({ action: 'eat, wash up and sit down', place: '', time });
    // Every sentence the fields can make reads back to the same sentence.
    for (const d of [
      { action: 'brush my teeth', place: '', time },
      { action: 'look at my phone', place: 'the desk', time },
      { action: 'eat, wash up', place: 'home', time },
    ]) {
      const cue = cueFromDraft(d)!;
      expect(cueFromDraft(cueDraft(cue))).toEqual(cue);
    }
  });

  it('plans a rest day ahead and lists it with a way to cancel', async () => {
    const day = shiftDay(dayKey(), 3);
    await db.restTokens.put({ date: shiftDay(dayKey(), 2), week: dayKey(), usedAt: new Date() });
    renderAt('/settings', '/settings', <Settings />);
    const habits = await section('Habits');
    expect(within(habits).getByText(/2 a week/)).toBeTruthy();
    fireEvent.change(within(habits).getByLabelText('Rest day to plan'), { target: { value: day } });
    fireEvent.click(within(habits).getByRole('button', { name: 'Plan a rest day' }));
    await waitFor(() => expect(mocks.spendRestToken).toHaveBeenCalledWith(day));
    fireEvent.click(await within(habits).findByRole('button', { name: /Cancel the rest day/ }));
    expect(mocks.cancelPlannedToken).toHaveBeenCalledWith(shiftDay(dayKey(), 2));
  });

  it('starts and ends travel mode', async () => {
    const until = shiftDay(dayKey(), 7);
    renderAt('/settings', '/settings', <Settings />);
    const habits = await section('Habits');
    fireEvent.change(within(habits).getByLabelText('Away until'), { target: { value: until } });
    fireEvent.click(within(habits).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.setTravel).toHaveBeenCalledWith(until));

    await updateSettings({ travelUntil: until });
    fireEvent.click(await within(habits).findByRole('button', { name: "I'm back" }));
    await waitFor(() => expect(mocks.setTravel).toHaveBeenCalledWith(null));
  });

  it('keeps travel mode within the days it can cover', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const habits = await section('Habits');
    const date = within(habits).getByLabelText('Away until') as HTMLInputElement;
    expect(date.max).toBe(shiftDay(dayKey(), 59));
    fireEvent.change(date, { target: { value: shiftDay(dayKey(), 75) } });
    expect((within(habits).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
    expect(date.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(date, { target: { value: shiftDay(dayKey(), 59) } });
    fireEvent.click(within(habits).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mocks.setTravel).toHaveBeenCalledWith(shiftDay(dayKey(), 59)));
  });

  it('downloads the reminders again', async () => {
    await updateSettings({ cue: { text: 'After I wake up, I open Issho', time: '07:00' } });
    renderAt('/settings', '/settings', <Settings />);
    fireEvent.click(within(await section('Habits')).getByRole('button', { name: /Download reminders/ }));
    expect(mocks.downloadIcs).toHaveBeenCalledTimes(1);
    expect((mocks.downloadIcs.mock.calls[0] as unknown as [string])[0]).toContain('DTSTART');
  });
});

describe('Settings: together', () => {
  it('saves the slots and goal on this phone, and posts them when paired', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    renderAt('/settings', '/settings', <Settings />);
    const together = await section('Together');
    fireEvent.change(within(together).getByLabelText('Session B day'), { target: { value: '5' } });
    fireEvent.click(within(together).getByRole('button', { name: 'Save sessions and goal' }));
    expect(await within(together).findByText('Saved, and shared with your partner.')).toBeTruthy();
    const slots = [
      { session: 'A', weekday: 2, time: '20:00' },
      { session: 'B', weekday: 5, time: '20:00' },
      { session: 'C', weekday: 7, time: '20:00' },
    ];
    expect((await getSettings()).togetherSlots).toEqual(slots);
    expect(mocks.postTogetherEvent).toHaveBeenCalledWith({ type: 'slots', slots });
  });

  it('keeps accuracy private by default and shares it on request', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const together = await section('Together');
    const share = within(together).getByRole('switch', { name: /Share my accuracy/ }) as HTMLInputElement;
    expect(share.checked).toBe(false);
    fireEvent.click(share);
    await waitFor(async () => expect((await getSettings()).shareAccuracy).toBe(true));
  });

  it('offers to connect when this phone is not paired', async () => {
    renderAt('/settings', '/settings', <Settings />);
    expect(within(await section('Together')).getByText('Pairing form')).toBeTruthy();
  });

  it('disconnects this phone only after confirming', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
    renderAt('/settings', '/settings', <Settings />);
    const together = await section('Together');
    expect(await within(together).findByText('Our home')).toBeTruthy();
    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect this phone' }));
    fireEvent.click(within(together).getByRole('button', { name: 'Cancel' }));
    expect((await getSettings()).deviceToken).toBe('token');
    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect this phone' }));
    fireEvent.click(within(together).getByRole('button', { name: 'Disconnect' }));
    expect(await within(together).findByText('Pairing form')).toBeTruthy();
    expect(await getSettings()).toMatchObject({ deviceToken: undefined, memberId: undefined, name: 'Sam' });
  });

  it('sends the name again when the home server still has an older one', async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'm-sam', name: 'Sam C' });
    server.household = {
      householdName: 'Our home', me: 'm-sam', members: [member('m-sam', 'Sam'), member('m-anna', 'Anna')], sharedStreak: 0,
      quest: { week: '2026-10-12', minimumDays: {}, togetherSessions: 0, shortfall: 0, met: false, reserveUsed: false, reserveLeft: true, daysLeft: 3 },
      questStreakWeeks: 0,
    };
    renderAt('/settings', '/settings', <Settings />);
    await waitFor(() => expect(server.renameMember).toHaveBeenCalledWith('Sam C'));
  });

  it("says the AI helper isn't working when the chat found it broken", async () => {
    server.aiEnabled = true;
    try {
      await updateSettings({ deviceToken: 'token', memberId: 'm-sam', householdName: 'Our home' });
      renderAt('/settings', '/settings', <Settings />);
      const together = await section('Together');
      expect(await within(together).findByText(/^On: private tips/)).toBeTruthy();
      act(() => markAiBroken('ai_misconfigured'));
      expect(await within(together).findByText(/Not working: the home server's API key/)).toBeTruthy();
    } finally {
      server.aiEnabled = false;
      resetAiAvailability();
    }
  });
});

describe('Settings: data', () => {
  it('only deletes after the learner types "reset"', async () => {
    const data = await openReset();
    const confirm = within(data).getByRole('button', { name: 'Delete all progress' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(data).getByLabelText('Type “reset” to confirm'), { target: { value: 'reset' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(await within(data).findByText('All progress was reset. Today starts fresh.')).toBeTruthy();
    expect(await db.items.count()).toBe(0);
    expect(await getSettings()).toMatchObject({ name: 'Sam', onboarded: true });
  });

  it('clears every v2 progress table, and keeps settings, chat and queued together events', async () => {
    const kept = new Set(['settings', 'messages', 'outbox', 'togetherOutbox']);
    const now = new Date();
    await db.reviewLogs.add({
      cardId: 'kanji:日|write', itemId: 'kanji:日', kind: 'kanji', type: 'write', grade: 3, reviewedAt: now, durationMs: 4000,
      mode: 'written', prevState: 2, elapsedDays: 3, context: 'review',
    });
    await db.savedSentences.add({ id: 's-1', jp: '{日|ひ}', en: 'day', savedAt: now, source: 'reading', blank: { surface: '日', reading: 'ひ' } });
    await db.encounters.add({ itemId: 'kanji:日', day: dayKey(), source: 'sentence', at: now });
    await db.shownSentences.add({ id: 's-1', day: dayKey(), count: 1 });
    await db.staged.add({ itemId: 'word:w-nichi', kanji: '日', releaseDay: dayKey(), slot: 2 });
    await db.stories.add({ storyId: 'st-start-01', stage: 1, gist: [true], cpm: [] });
    await db.restTokens.add({ date: dayKey(), week: dayKey(), usedAt: now });
    await db.outputs.add({ id: 'o-1', day: dayKey(), target: { ref: 'core:cw-0002', label: 'もう', en: 'already' }, draft: 'x', text: 'x', check: 'done', createdAt: now });
    await db.canDos.add({ id: 'u01-cd1', unit: 1, attempts: 1 });
    await db.milestones.add({ id: 'M0', reachedAt: now });
    await db.togetherPlans.add({ week: dayKey(), plan: { week: dayKey(), sessions: [], settledUnit: 0, monthly: false, showcase: false }, updatedAt: now });
    await db.togetherOutbox.add({ clientId: 't-1', createdAt: now, week: dayKey(), event: '{}', attempts: 0 });
    await db.partnerQuizzes.add({ quizId: 'q-1', role: 'answerer', createdAt: now, graded: 1, practiced: 0 });
    await db.pitchBoxes.add({ ref: 'core:cw-0005', box: 1, nextDay: dayKey(), seen: 1, correct: 1 });
    await db.fluency.add({ kind: 'speed', day: dayKey(), at: now, value: 12 });
    await db.messages.add({ id: 1, clientId: 'c-1', memberId: 'm-anna', createdAt: now.toISOString(), kind: 'text', text: 'おはよう' });
    await db.outbox.add({ clientId: 'c-2', createdAt: now, kind: 'text', text: 'おやすみ', attempts: 0 });
    for (const table of db.tables) expect(await table.count(), table.name).toBeGreaterThan(0);
    expect([...RESET_TABLES, ...kept].sort()).toEqual(db.tables.map((t) => t.name).sort());

    const data = await openReset();
    fireEvent.change(within(data).getByLabelText('Type “reset” to confirm'), { target: { value: 'reset' } });
    fireEvent.click(within(data).getByRole('button', { name: 'Delete all progress' }));
    await within(data).findByText('All progress was reset. Today starts fresh.');
    for (const table of db.tables) {
      expect(await table.count(), table.name).toBe(kept.has(table.name) ? 1 : 0);
    }
    expect(mocks.applyPlacement).not.toHaveBeenCalled();
  });

  it('starts a script the learner passed the check for as known again', async () => {
    await updateSettings({ knowsHiragana: true });
    const data = await openReset();
    fireEvent.change(within(data).getByLabelText('Type “reset” to confirm'), { target: { value: 'reset' } });
    fireEvent.click(within(data).getByRole('button', { name: 'Delete all progress' }));
    await within(data).findByText('All progress was reset. Today starts fresh.');
    expect(mocks.applyPlacement).toHaveBeenCalledWith('hiragana', 20);
  });

  it('can be cancelled without touching anything', async () => {
    const data = await openReset();
    fireEvent.click(within(data).getByRole('button', { name: 'Cancel' }));
    expect(within(data).getByRole('button', { name: 'Reset all progress' })).toBeTruthy();
    expect(await db.items.count()).toBe(2);
  });

  it('says why a v1 backup brings back only settings and chat', async () => {
    mocks.backup.progressDropped = true;
    renderAt('/settings', '/settings', <Settings />);
    const data = await section('Data');
    const input = within(data).getByLabelText('Backup file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['{}'], 'old.json', { type: 'application/json' })] } });
    expect(await within(data).findByText(/earlier version of Issho/)).toBeTruthy();
    fireEvent.click(within(data).getByRole('button', { name: 'Restore settings and chat' }));
    expect(await within(data).findByText(/progress was from the earlier course/)).toBeTruthy();
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
});

describe('Settings: about', () => {
  it('credits the VOICEVOX voices, with a link to VOICEVOX', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const about = await section('About');
    expect(await within(about).findByText(/VOICEVOX:No\.7, VOICEVOX:青山龍星/)).toBeTruthy();
    expect(within(about).getByRole('link', { name: 'VOICEVOX' }).getAttribute('href')).toBe('https://voicevox.hiroshiba.jp/');
    for (const name of ['KanjiVG', 'KANJIDIC2', 'JMdict']) expect(within(about).getByRole('link', { name })).toBeTruthy();
  });
});

describe('Settings: appearance', () => {
  it('switches the theme and remembers it', async () => {
    renderAt('/settings', '/settings', <Settings />);
    const look = await section('Appearance');
    fireEvent.click(within(look).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('issho.theme')).toBe('dark');
  });
});

it('has a real page heading', async () => {
  renderAt('/settings', '/settings', <Settings />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
});
