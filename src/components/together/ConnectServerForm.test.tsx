import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../../lib/db.ts';
import { ApiError, INVALID_SERVER_URL_MESSAGE } from '../../sync/client.ts';
import { ConnectServerForm, pairErrorMessage } from './ConnectServerForm.tsx';

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  pushStats: vi.fn(async () => true),
  connectFromSettings: vi.fn(async () => {}),
}));

vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()),
  pair: mocks.pair,
}));
vi.mock('../../sync/stats.ts', () => ({ pushStats: mocks.pushStats }));
vi.mock('../../sync/socket.ts', () => ({ connectFromSettings: mocks.connectFromSettings }));

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ name: 'Aiko' });
  setOnline(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setOnline(true);
});

async function fill(code: string, server?: string) {
  await screen.findByDisplayValue('Aiko');
  fireEvent.change(screen.getByLabelText('Household code'), { target: { value: code } });
  if (server !== undefined) fireEvent.change(screen.getByLabelText('Server address'), { target: { value: server } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

describe('ConnectServerForm', () => {
  it('prefills the name and pairs, then shares stats and connects', async () => {
    mocks.pair.mockResolvedValue({ deviceToken: 't', memberId: 'm', householdName: 'Home' });
    const onConnected = vi.fn();
    render(<ConnectServerForm onConnected={onConnected} />);
    await fill(' sesame ');

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(mocks.pair).toHaveBeenCalledWith({ serverUrl: '', householdCode: ' sesame ', name: 'Aiko' });
    expect(mocks.pushStats).toHaveBeenCalledWith({ immediate: true });
    expect(mocks.connectFromSettings).toHaveBeenCalled();
  });

  it('says when the household code is wrong', async () => {
    mocks.pair.mockRejectedValue(new ApiError(401, 'invalid_code'));
    const onConnected = vi.fn();
    render(<ConnectServerForm onConnected={onConnected} />);
    await fill('nope');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("That household code didn't work");
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect' }).getAttribute('aria-disabled')).toBeNull();
    // The code field is marked, described by the message and focused, so focus never falls to the page (V086).
    const code = screen.getByLabelText('Household code');
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(code.getAttribute('aria-invalid')).toBe('true');
    expect(code.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('keeps focus on Connect while it tries (aria-disabled, not disabled)', async () => {
    let fail: (e: unknown) => void = () => {};
    mocks.pair.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    render(<ConnectServerForm onConnected={() => {}} />);
    await screen.findByDisplayValue('Aiko');
    fireEvent.change(screen.getByLabelText('Household code'), { target: { value: 'code' } });
    const connect = screen.getByRole('button', { name: 'Connect' });
    connect.focus();
    fireEvent.click(connect);
    const busy = await screen.findByRole('button', { name: 'Connecting…' });
    expect(busy).toBe(connect);
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy).toHaveProperty('disabled', false);
    expect(document.activeElement).toBe(busy);
    // A second press while busy does nothing.
    fireEvent.click(busy);
    expect(mocks.pair).toHaveBeenCalledTimes(1);
    fail(new ApiError(0, 'network'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    // Not the code's fault: nothing is marked, and focus stays on Connect.
    expect(screen.getByLabelText('Household code').getAttribute('aria-invalid')).toBeNull();
    expect(document.activeElement).toBe(connect);
  });

  it('names the address it could not reach', async () => {
    mocks.pair.mockRejectedValue(new ApiError(0, 'network'));
    render(<ConnectServerForm onConnected={() => {}} />);
    await fill('code', '192.168.1.20:8787');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't reach the home server at 192.168.1.20:8787");
    expect(mocks.pair).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: '192.168.1.20:8787' }));
  });

  it('marks the address when it is not an Issho home server', async () => {
    mocks.pair.mockRejectedValue(new ApiError(404, 'not_found'));
    render(<ConnectServerForm onConnected={() => {}} />);
    await fill('code', 'example.com');
    const alert = await screen.findByRole('alert');
    const server = screen.getByLabelText('Server address');
    await waitFor(() => expect(document.activeElement).toBe(server));
    expect(server.getAttribute('aria-invalid')).toBe('true');
    expect(server.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });

  it('does not try while offline', async () => {
    setOnline(false);
    render(<ConnectServerForm onConnected={() => {}} />);
    await fill('code');

    expect((await screen.findByRole('alert')).textContent).toContain("You're offline");
    expect(mocks.pair).not.toHaveBeenCalled();
  });

  it('asks for the code before trying', async () => {
    render(<ConnectServerForm onConnected={() => {}} />);
    await fill('   ');

    expect((await screen.findByRole('alert')).textContent).toContain('Enter the household code');
    expect(mocks.pair).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Household code')));
  });

  it('shows and hides the code, and offers to skip', async () => {
    const onSkip = vi.fn();
    render(<ConnectServerForm onConnected={() => {}} onSkip={onSkip} compact />);
    const code = screen.getByLabelText('Household code');
    expect(code.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Show household code' }));
    expect(code.getAttribute('type')).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onSkip).toHaveBeenCalled();
  });
});

describe('pairErrorMessage', () => {
  it('maps server and network failures to next steps', () => {
    expect(pairErrorMessage(new ApiError(429, 'rate_limited'))).toContain('Wait a minute');
    expect(pairErrorMessage(new ApiError(0, 'timeout'))).toContain('took too long');
    expect(pairErrorMessage(new ApiError(503, 'http_503'))).toContain('had a problem');
    expect(pairErrorMessage(new ApiError(404, 'not_found'), 'example.com')).toContain("example.com doesn't look like an Issho");
    expect(pairErrorMessage(new ApiError(200, 'bad_response'))).toContain('Add its address under Advanced');
    expect(pairErrorMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
  });

  it('explains an address that cannot be one, and does not double punctuation after an address', () => {
    expect(pairErrorMessage(new ApiError(0, 'invalid_server_url'), 'not a url!!')).toBe(INVALID_SERVER_URL_MESSAGE);
    expect(pairErrorMessage(new ApiError(0, 'network'), '192.168.1.20:8787'))
      .toBe("Couldn't reach the home server at 192.168.1.20:8787. Check it's running and this phone is on the same network.");
    expect(pairErrorMessage(new ApiError(0, 'network'), 'issho.home.')).toContain('at issho.home. Check');
    expect(pairErrorMessage(new ApiError(0, 'network'))).toContain("Couldn't reach the home server. Check");
  });
});
