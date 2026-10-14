import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientEvent, HouseholdResponse, ServerEvent } from '../../../shared/api.ts';
import { db, updateSettings } from '../../lib/db.ts';
import type { RolePlay } from '../../lib/types.ts';
import RolePlayRun from '../../screens/RolePlayRun.tsx';
import { resetLive } from './live.ts';
import { rolePlayHistory } from './storage.ts';

const SCRIPT: RolePlay = {
  id: 'rp-cafe',
  title: 'At the café',
  titleJp: 'カフェで',
  level: 1,
  setting: 'Ordering a drink.',
  roles: { a: { name: 'Guest', nameJp: 'きゃく' }, b: { name: 'Server', nameJp: 'てんいん' } },
  lines: [
    { role: 'a', jp: 'コーヒーを ください。', en: 'A coffee, please.', hint: 'ください = please give me.' },
    { role: 'b', jp: 'はい、どうぞ。', en: 'Here you are.' },
    { role: 'a', jp: 'ありがとう。', en: 'Thank you.' },
  ],
};

const HOUSEHOLD: HouseholdResponse = {
  householdName: 'Home',
  me: 'me',
  sharedStreak: 0,
  members: [
    { member: { id: 'me', name: 'Aiko', joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1, updatedAt: null },
    { member: { id: 'ken', name: 'Ken', joinedAt: '', lastSeenAt: null }, days: [], streak: 0, kanjiKnown: 0, knownKanji: [], phase: 1, updatedAt: null },
  ],
};

const mocks = vi.hoisted(() => ({
  status: 'offline' as 'online' | 'offline',
  listeners: new Set<(ev: ServerEvent) => void>(),
  presence: new Map<string, boolean>(),
  sent: [] as ClientEvent[],
}));

vi.mock('../../sync/socket.ts', () => ({
  useServerStatus: () => mocks.status,
  onServerEvent: (cb: (ev: ServerEvent) => void) => {
    mocks.listeners.add(cb);
    return () => { mocks.listeners.delete(cb); };
  },
  onStatusChange: () => () => {},
  usePresence: (memberId: string | undefined) => (memberId ? mocks.presence.get(memberId) : undefined),
  sendClientEvent: (ev: ClientEvent) => {
    mocks.sent.push(ev);
    return true;
  },
}));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({ data: HOUSEHOLD, loading: false, refresh: async () => {} }),
}));
vi.mock('../../lib/data.ts', () => ({ loadRolePlays: async () => [SCRIPT] }));

function emit(ev: ServerEvent) {
  act(() => { for (const cb of [...mocks.listeners]) cb(ev); });
}

function renderRun() {
  return render(
    <MemoryRouter initialEntries={['/roleplay/rp-cafe']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/roleplay/:id" element={<RolePlayRun />} /></Routes>
    </MemoryRouter>,
  );
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  localStorage.clear();
  resetLive();
  mocks.status = 'offline';
  mocks.sent = [];
  mocks.presence.clear();
});

afterEach(() => {
  cleanup();
});

describe('RolePlayRun on one phone', () => {
  it('runs through the script, then swaps roles', async () => {
    renderRun();
    expect(await screen.findByRole('heading', { name: 'At the café' })).toBeTruthy();
    // Unpaired: two phones isn't possible yet.
    const duo = screen.getByRole('radio', { name: 'Together, two phones' });
    expect(duo).toHaveProperty('disabled', true);
    expect(duo.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Connect to your home server on the Together tab first.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'On this phone' })).toHaveProperty('checked', true);

    pick('Guest');
    click('Start');

    // Line 1 is mine.
    expect(screen.getByText('Your line · Guest')).toBeTruthy();
    expect(screen.getByText('A coffee, please.')).toBeTruthy();
    expect(screen.getByText('ください = please give me.')).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    click('I said it');

    // Line 2 is the partner's: hidden until asked for.
    expect(screen.getByRole('heading', { name: 'Listen to your partner' })).toBeTruthy();
    expect(screen.queryByText('Here you are.')).toBeNull();
    click('Show line');
    expect(screen.getByText('Here you are.')).toBeTruthy();
    click('Next');

    expect(screen.getByText('Your line · Guest')).toBeTruthy();
    click('I said it');

    expect(screen.getByRole('heading', { name: 'Nicely done' })).toBeTruthy();
    expect(screen.getByText(/as Guest/)).toBeTruthy();
    await waitFor(() => expect(rolePlayHistory()['rp-cafe']).toBeGreaterThan(0));

    click('Swap roles and go again');
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Listen to your partner' })).toBeTruthy();
    click('Next');
    expect(screen.getByText('Your line · Server')).toBeTruthy();
  });

  it('can read both parts', async () => {
    renderRun();
    await screen.findByRole('heading', { name: 'At the café' });
    pick('Both');
    click('Start');
    expect(screen.getByText("Guest's line")).toBeTruthy();
    click('I said it');
    expect(screen.getByText("Server's line")).toBeTruthy();
    expect(screen.getByText('Here you are.')).toBeTruthy();
  });
});

describe('RolePlayRun on two phones', () => {
  beforeEach(async () => {
    await updateSettings({ deviceToken: 'token', memberId: 'me', name: 'Aiko' });
    mocks.status = 'online';
  });

  it("says whether the partner's phone is connected, and only offers two phones when it is", async () => {
    mocks.presence.set('ken', false);
    const first = renderRun();
    await screen.findByRole('heading', { name: 'At the café' });
    expect(screen.getByText('Ken is offline right now.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Together, two phones' })).toHaveProperty('disabled', true);
    first.unmount();

    mocks.presence.set('ken', true);
    renderRun();
    expect(await screen.findByText('Ken is online. Each phone shows its own part.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Together, two phones' })).toHaveProperty('disabled', false);
  });

  it('waits for the partner, then advances when their phone does', async () => {
    renderRun();
    await screen.findByRole('heading', { name: 'At the café' });
    const duo = await screen.findByRole('radio', { name: 'Together, two phones' });
    await waitFor(() => expect(duo).toHaveProperty('disabled', false));
    fireEvent.click(duo);
    pick('Server');
    click('Start together');

    expect(screen.getByRole('heading', { name: 'Waiting for Ken…' })).toBeTruthy();
    const waiting = mocks.sent.at(-1);
    expect(waiting).toMatchObject({ type: 'roleplay', state: { scriptId: 'rp-cafe', role: 'b', lineIndex: 0, status: 'waiting' } });
    const sessionId = waiting?.type === 'roleplay' ? waiting.state.sessionId : '';

    // Ken's phone joins as the guest; line 1 is theirs.
    emit({ type: 'roleplay', memberId: 'ken', state: { sessionId, scriptId: 'rp-cafe', role: 'a', lineIndex: 0, status: 'active' } });
    expect(screen.getByRole('heading', { name: 'Listen to Ken' })).toBeTruthy();
    expect(screen.getByText('Ken is saying this line…')).toBeTruthy();

    // Their phone moves on: so does this one, to my line.
    emit({ type: 'roleplay', memberId: 'ken', state: { sessionId, scriptId: 'rp-cafe', role: 'a', lineIndex: 1, status: 'active' } });
    expect(screen.getByText('Your line · Server')).toBeTruthy();
    click('I said it');
    expect(mocks.sent.at(-1)).toMatchObject({ state: { sessionId, role: 'b', lineIndex: 2, status: 'active' } });

    // Events for other sessions are ignored.
    emit({ type: 'roleplay', memberId: 'ken', state: { sessionId: 'other', scriptId: 'rp-cafe', role: 'a', lineIndex: 3, status: 'done' } });
    expect(screen.getByText('3 / 3')).toBeTruthy();

    emit({ type: 'roleplay', memberId: 'ken', state: { sessionId, scriptId: 'rp-cafe', role: 'a', lineIndex: 3, status: 'done' } });
    expect(screen.getByRole('heading', { name: 'Nicely done' })).toBeTruthy();
  });

  it('withdraws its invite at once when the wait is cancelled or left', async () => {
    const startWaiting = async () => {
      await screen.findByRole('heading', { name: 'At the café' });
      const duo = await screen.findByRole('radio', { name: 'Together, two phones' });
      await waitFor(() => expect(duo).toHaveProperty('disabled', false));
      fireEvent.click(duo);
      click('Start together');
      const waiting = mocks.sent.at(-1);
      expect(waiting).toMatchObject({ type: 'roleplay', state: { status: 'waiting' } });
      return waiting?.type === 'roleplay' ? waiting.state : undefined;
    };

    const view = renderRun();
    const first = await startWaiting();
    click('Cancel');
    expect(mocks.sent.at(-1)).toEqual({ type: 'roleplay', state: { ...first, status: 'done' } });
    expect(screen.getByRole('heading', { name: 'At the café' })).toBeTruthy();

    const second = await startWaiting();
    expect(second?.sessionId).not.toBe(first?.sessionId);
    view.unmount();
    expect(mocks.sent.at(-1)).toEqual({ type: 'roleplay', state: { ...second, status: 'done' } });
  });

  it('brings a partner who fell behind back to this line', async () => {
    renderRun();
    await screen.findByRole('heading', { name: 'At the café' });
    const state = (lineIndex: number, status: 'active' | 'done' = 'active', role: 'a' | 'b' = 'a') =>
      ({ sessionId: 's-ken', scriptId: 'rp-cafe', role, lineIndex, status });
    emit({ type: 'roleplay', memberId: 'ken', state: { ...state(0), status: 'waiting' } });
    click('Join as Server');
    click('Next');
    click('I said it');
    expect(screen.getByText('3 / 3')).toBeTruthy();

    // Ken's phone is back from a dropped connection, still on line 2: tell it where we are.
    mocks.sent = [];
    emit({ type: 'roleplay', memberId: 'ken', state: state(1) });
    expect(mocks.sent).toEqual([{ type: 'roleplay', state: state(2, 'active', 'b') }]);
    expect(screen.getByText('3 / 3')).toBeTruthy();

    // Level again: nothing more to say.
    mocks.sent = [];
    emit({ type: 'roleplay', memberId: 'ken', state: state(2) });
    expect(mocks.sent).toEqual([]);

    // Ken finishes, then swaps roles to go again: this phone follows instead of insisting it's done.
    emit({ type: 'roleplay', memberId: 'ken', state: state(3, 'done') });
    expect(screen.getByRole('heading', { name: 'Nicely done' })).toBeTruthy();
    mocks.sent = [];
    emit({ type: 'roleplay', memberId: 'ken', state: state(0, 'active', 'b') });
    expect(screen.getByText('Your line · Guest')).toBeTruthy();
    expect(mocks.sent).toEqual([{ type: 'roleplay', state: state(0, 'active', 'a') }]);
  });

  it('joins a role-play the partner started', async () => {
    renderRun();
    await screen.findByRole('heading', { name: 'At the café' });
    emit({ type: 'roleplay', memberId: 'ken', state: { sessionId: 's-ken', scriptId: 'rp-cafe', role: 'a', lineIndex: 0, status: 'waiting' } });

    click('Join as Server');
    expect(mocks.sent.at(-1)).toMatchObject({ state: { sessionId: 's-ken', role: 'b', lineIndex: 0, status: 'active' } });
    expect(screen.getByRole('heading', { name: 'Listen to Ken' })).toBeTruthy();
  });
});
