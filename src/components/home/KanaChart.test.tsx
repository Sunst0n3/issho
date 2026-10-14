import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KanaChart from '../../screens/KanaChart.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

beforeEach(resetDb);
afterEach(cleanup);

const isSheetEntry = () => Boolean((window.history.state as Record<string, unknown> | null)?.isshoSheet);

describe('Kana chart sheet', () => {
  it('closes on the back gesture instead of leaving the chart', async () => {
    renderAt('/kana', '/kana', <KanaChart />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Kana chart' })).toBeTruthy();
    const before = window.history.length;
    fireEvent.click(await screen.findByRole('button', { name: 'あ, a' }));
    expect(screen.getByRole('dialog', { name: 'あ, a' })).toBeTruthy();
    // The open sheet has its own history entry...
    expect(window.history.length).toBe(before + 1);
    expect(isSheetEntry()).toBe(true);

    // ...which Back pops: the sheet closes and the chart stays.
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
