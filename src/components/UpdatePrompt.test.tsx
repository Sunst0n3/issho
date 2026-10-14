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

/** A stand-in for navigator.serviceWorker: `controller` is set once a worker controls the page. */
class FakeContainer extends EventTarget {
  controller: object | null = null;
  takeControl() {
    this.controller = {};
    this.dispatchEvent(new Event('controllerchange'));
  }
}

function installContainer(controlled: boolean): FakeContainer {
  const container = new FakeContainer();
  if (controlled) container.controller = {};
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
  return container;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.assign(sw, { needRefresh: false, offlineReady: false });
  vi.clearAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
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
    installContainer(true);
    sw.offlineReady = true;
    render(<UpdatePrompt />);
    expect(screen.getByRole('status').textContent).toContain('offline');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(sw.setOfflineReady).toHaveBeenCalledWith(false);
  });

  it('says "Ready to use offline" only once the service worker controls this page', () => {
    // First visit: the worker installed, but this page was loaded from the network.
    const container = installContainer(false);
    sw.offlineReady = true;
    const { container: root } = render(<UpdatePrompt />);
    expect(root.childElementCount).toBe(0);
    expect(sw.setOfflineReady).not.toHaveBeenCalled();

    act(() => container.takeControl());
    expect(screen.getByRole('status').textContent).toContain('Ready to use offline');
  });

  it('never claims offline use where there are no service workers (an http:// address)', () => {
    sw.offlineReady = true;
    const { container } = render(<UpdatePrompt />);
    expect(container.childElementCount).toBe(0);
  });
});
