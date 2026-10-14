import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings, updateSettings } from '../../lib/db.ts';
import Onboarding from '../../screens/Onboarding.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

const mocks = vi.hoisted(() => ({
  applyKnownKana: vi.fn(async () => 104),
  requestPersistentStorage: vi.fn(async () => true),
}));

vi.mock('../../srs/course.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../srs/course.ts')>()),
  applyKnownKana: mocks.applyKnownKana,
}));
vi.mock('../../lib/backup.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/backup.ts')>()),
  requestPersistentStorage: mocks.requestPersistentStorage,
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

beforeEach(resetDb);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

describe('Onboarding', () => {
  it('walks through every step and saves the choices', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);

    expect(await screen.findByRole('heading', { name: 'Japanese, together' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 5')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    const name = await screen.findByLabelText('Your name');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: '  Sam ' } });
    next();

    await screen.findByRole('heading', { name: 'Already know some kana?' });
    fireEvent.click(screen.getByRole('switch', { name: /I know hiragana/ }));
    expect((screen.getByRole('switch', { name: /I know hiragana/ }) as HTMLInputElement).checked).toBe(true);
    next();

    await screen.findByRole('heading', { name: 'How much each day?' });
    fireEvent.click(screen.getByRole('radio', { name: /8 new a day/ }));
    next();

    await screen.findByRole('heading', { name: 'Study together' });
    expect(screen.getByText('Step 5 of 5')).toBeTruthy();
    // The name is saved before this step, so the pairing form can use it.
    expect((await getSettings()).name).toBe('Sam');
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(await screen.findByText('Home screen')).toBeTruthy();
    const s = await getSettings();
    expect(s).toMatchObject({
      onboarded: true,
      name: 'Sam',
      newPerDay: 8,
      knowsHiragana: true,
      knowsKatakana: false,
      romaji: true,
    });
    expect(mocks.applyKnownKana).toHaveBeenCalledTimes(1);
    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
  });

  it("doesn't mark kana known when the learner starts from scratch, and finishes after connecting", async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Alex' } });
    next();
    await screen.findByRole('heading', { name: 'Already know some kana?' });
    next();
    await screen.findByRole('heading', { name: 'How much each day?' });
    expect((screen.getByRole('radio', { name: /5 new a day/ }) as HTMLInputElement).checked).toBe(true);
    next();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Home screen')).toBeTruthy();
    expect(await getSettings()).toMatchObject({ onboarded: true, name: 'Alex', newPerDay: 5 });
    expect(mocks.applyKnownKana).not.toHaveBeenCalled();
  });

  it('starts from the saved answers when run a second time', async () => {
    await updateSettings({ onboarded: true, name: 'Sam', knowsHiragana: true, newPerDay: 3, deviceToken: 'token' });
    renderAt('/welcome', '/welcome', <Onboarding />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    expect(((await screen.findByLabelText('Your name')) as HTMLInputElement).value).toBe('Sam');
    next();
    await screen.findByRole('heading', { name: 'Already know some kana?' });
    expect((screen.getByRole('switch', { name: /I know hiragana/ }) as HTMLInputElement).checked).toBe(true);
    next();
    await screen.findByRole('heading', { name: 'How much each day?' });
    expect((screen.getByRole('radio', { name: /3 new a day/ }) as HTMLInputElement).checked).toBe(true);
    next();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(await screen.findByText('Home screen')).toBeTruthy();
    expect(await getSettings()).toMatchObject({ onboarded: true, name: 'Sam', newPerDay: 3, knowsHiragana: true, deviceToken: 'token' });
  });

  it('goes back a step without losing answers', async () => {
    renderAt('/welcome', '/welcome', <Onboarding />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get started' }));
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Kim' } });
    next();
    await screen.findByRole('heading', { name: 'Already know some kana?' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(((await screen.findByLabelText('Your name')) as HTMLInputElement).value).toBe('Kim');
  });
});
