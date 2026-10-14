import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpdatePrompt from './UpdatePrompt.tsx';

const sw = vi.hoisted(() => ({
  needRefresh: false,
  offlineReady: false,
  setNeedRefresh: vi.fn(),
  setOfflineReady: vi.fn(),
  updateServiceWorker: vi.fn(async () => {}),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [sw.needRefresh, sw.setNeedRefresh],
    offlineReady: [sw.offlineReady, sw.setOfflineReady],
    updateServiceWorker: sw.updateServiceWorker,
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.assign(sw, { needRefresh: false, offlineReady: false });
  vi.clearAllMocks();
});

describe('UpdatePrompt', () => {
  it('renders nothing when there is no news', () => {
    const { container } = render(<UpdatePrompt />);
    expect(container.childElementCount).toBe(0);
  });

  it('offers a reload when a new version is waiting', () => {
    sw.needRefresh = true;
    render(<UpdatePrompt />);
    expect(screen.getByRole('status').textContent).toContain('New version available');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(sw.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('can be dismissed until the next launch', () => {
    sw.needRefresh = true;
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(sw.setNeedRefresh).toHaveBeenCalledWith(false);
  });

  it('briefly confirms the app works offline', () => {
    vi.useFakeTimers();
    sw.offlineReady = true;
    render(<UpdatePrompt />);
    expect(screen.getByRole('status').textContent).toContain('offline');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(sw.setOfflineReady).toHaveBeenCalledWith(false);
  });
});
