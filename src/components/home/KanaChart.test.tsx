import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db.ts';
import KanaChart from '../../screens/KanaChart.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

const mocks = vi.hoisted(() => ({ play: vi.fn(async () => ({ via: 'clip', ms: 300, interrupted: false })) }));

// One rule lesson: the combination きゃ is taught with it, not as an item of its own.
vi.mock('../../lib/data.ts', async () => ({
  ...(await import('./test-fixtures.tsx')).dataMock,
  loadKanaRules: async () => [{
    id: 'hira-yoon', day: 7, script: 'hiragana', title: 'Combinations', explanation: '',
    pairs: [{ from: 'き', to: 'きゃ', romaji: 'kya' }], practiceWords: [],
  }],
}));
vi.mock('../../speech/audio.ts', () => ({ play: mocks.play }));

beforeEach(resetDb);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const isSheetEntry = () => Boolean((window.history.state as Record<string, unknown> | null)?.isshoSheet);

describe('Kana chart', () => {
  it('shows romaji (the one place after the sprint) and which kana are met, counting the script on its tab', async () => {
    await db.items.add({ id: 'kana:あ', kind: 'kana', key: 'あ', introducedAt: new Date() });
    renderAt('/kana', '/kana', <KanaChart />);
    expect(await screen.findByRole('button', { name: 'あ, a, met' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'い, i' })).toBeTruthy();
    // The tab's own script, marks and combinations included (the Learn hub counts basic kana of both).
    expect(screen.getByText(/^1 of 6 hiragana met so far, with marks and combinations\./)).toBeTruthy();
    expect(screen.queryByText(/learned/)).toBeNull();
  });

  it('marks the kana of an introduced rule lesson as learned (they are not items of their own)', async () => {
    renderAt('/kana', '/kana', <KanaChart />);
    expect(await screen.findByRole('button', { name: 'きゃ, kya' })).toBeTruthy();
    await db.items.add({ id: 'kanaRule:hira-yoon', kind: 'kanaRule', key: 'hira-yoon', introducedAt: new Date() });
    expect(await screen.findByRole('button', { name: 'きゃ, kya, met' })).toBeTruthy();
    expect(screen.getByText(/^1 of 6 hiragana met/)).toBeTruthy();
  });

  it('plays the kana clip on a tap and offers practice writing on its own page', async () => {
    renderAt('/kana', '/kana', <KanaChart />);
    fireEvent.click(await screen.findByRole('button', { name: 'あ, a' }));
    expect(mocks.play).toHaveBeenCalledWith({ ref: 'kana:あ' }, { fallbackText: 'あ' });
    const sheet = screen.getByRole('dialog', { name: 'あ, a' });
    expect(within(sheet).getByRole('link', { name: /Practice writing/ }).getAttribute('href')).toBe(`/write/${encodeURIComponent('あ')}`);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Listen' }));
    expect(mocks.play).toHaveBeenCalledTimes(2);
  });

  it('explains a combination instead of offering to write it as one', async () => {
    renderAt('/kana', '/kana', <KanaChart />);
    fireEvent.click(await screen.findByRole('button', { name: 'きゃ, kya' }));
    const sheet = screen.getByRole('dialog', { name: 'きゃ, kya' });
    expect(sheet.textContent).toContain('followed by a small');
    expect(within(sheet).queryByRole('link', { name: /Practice writing/ })).toBeNull();
  });

  it('closes the sheet on the back gesture instead of leaving the chart', async () => {
    renderAt('/kana', '/kana', <KanaChart />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Kana chart' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'あ, a' }));
    expect(screen.getByRole('dialog', { name: 'あ, a' })).toBeTruthy();
    // The open sheet has its own history entry, which Back pops.
    expect(isSheetEntry()).toBe(true);
    await act(async () => {
      window.history.back();
      await waitFor(() => expect(isSheetEntry()).toBe(false));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'Kana chart' })).toBeTruthy();
  });

  it('removes its history entry when closed with the button', async () => {
    renderAt('/kana', '/kana', <KanaChart />);
    fireEvent.click(await screen.findByRole('button', { name: 'あ, a' }));
    expect(isSheetEntry()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(isSheetEntry()).toBe(false));
  });
});
