import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiAvailable, aiProblem, markAiBroken, resetAiAvailability, useAiAvailable } from './ai.ts';

const mocks = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock('../../sync/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/client.ts')>()), health: mocks.health,
}));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.health.mockReset();
  resetAiAvailability();
});
afterEach(() => { vi.useRealTimers(); });

describe('AI readiness recovery', () => {
  it('does not treat a configured but cold local model as ready', async () => {
    mocks.health.mockResolvedValue({ aiEnabled: true, aiReady: false });
    expect(await aiAvailable()).toBe(false);
  });

  it('retries transient failures and clears the notice after readiness returns', async () => {
    mocks.health.mockResolvedValue({ aiEnabled: true, aiReady: true });
    expect(await aiAvailable()).toBe(true);
    markAiBroken('ai_unavailable');
    expect(await aiAvailable()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await aiAvailable()).toBe(true);
    expect(aiProblem()).toBeUndefined();
  });

  it('refreshes a mounted helper when the engine warms up without reconnecting', async () => {
    mocks.health.mockResolvedValue({ aiEnabled: true, aiReady: false });
    const { result, unmount } = renderHook(() => useAiAvailable(true));
    await act(async () => {});
    expect(result.current).toBe(false);
    mocks.health.mockResolvedValue({ aiEnabled: true, aiReady: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current).toBe(true);
    unmount();
  });
});
