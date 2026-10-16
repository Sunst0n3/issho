import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.tsx';
import { db, updateSettings } from './lib/db.ts';

vi.mock('./screens/Library.tsx', async () => {
  const { Link } = await import('react-router-dom');
  return { default: () => <Link to="/kanji/水">水</Link> };
});
vi.mock('./screens/KanjiDetail.tsx', async () => {
  const { useNavigate } = await import('react-router-dom');
  return {
    default: function KanjiDetail() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(-1)}>Back</button>;
    },
  };
});
vi.mock('./screens/Today.tsx', async () => {
  const { Link } = await import('react-router-dom');
  return { default: () => <><h1>Today screen</h1><Link to="/settings">Settings</Link></> };
});
vi.mock('./screens/Settings.tsx', () => ({ default: () => <h1>Settings screen</h1> }));
vi.mock('./screens/LearnHub.tsx', () => ({ default: () => <h1>Learn screen</h1> }));
vi.mock('./screens/WritePractice.tsx', () => ({ default: () => <h1>Write screen</h1> }));
vi.mock('./screens/CanDoCheck.tsx', () => ({ default: () => <h1>Can-do screen</h1> }));
vi.mock('./screens/TogetherSession.tsx', () => ({ default: () => <h1>Together session screen</h1> }));

// The Together screen fails with the browser's "couldn't download the code" error
// while `offline` is set. (An error thrown by a vi.mock factory reaches the app
// wrapped in Vitest's own error, so the screen throws it instead.)
const together = vi.hoisted(() => ({ offline: false }));
vi.mock('./screens/Together.tsx', () => ({
  default: function Together() {
    if (together.offline) throw new TypeError('Failed to fetch dynamically imported module: /assets/Together-x.js');
    return <h1>Together screen</h1>;
  },
}));

// The Grammar screen throws while `broken` is set.
const grammar = vi.hoisted(() => ({ broken: false }));
vi.mock('./screens/GrammarList.tsx', () => ({
  default: function GrammarList() {
    if (grammar.broken) throw new Error('Something broke');
    return <h1>Grammar screen</h1>;
  },
}));

// jsdom can't reload a page.
const reload = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('./components/ui.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./components/ui.tsx')>()),
  reloadPage: reload.page,
}));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ onboarded: true, name: 'Sam' });
  reload.page.mockClear();
});

afterEach(() => {
  cleanup();
  document.documentElement.scrollTop = 0;
  vi.restoreAllMocks();
});

describe('App', () => {
  it('opens a new page at the top and leaves back navigation to the browser', async () => {
    renderApp('/library');
    const link = await screen.findByRole('link', { name: '水' });

    document.documentElement.scrollTop = 800;
    fireEvent.click(link);
    const back = await screen.findByRole('button', { name: 'Back' });
    expect(document.documentElement.scrollTop).toBe(0);

    document.documentElement.scrollTop = 300;
    fireEvent.click(back);
    await screen.findByRole('link', { name: '水' });
    expect(document.documentElement.scrollTop).toBe(300);
  });

  it('shows "page not found" with the tab bar and a way home for an unknown address', async () => {
    renderApp('/does/not/exist');
    expect(await screen.findByRole('heading', { level: 1, name: "This page doesn't exist" })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Go to Today/ }));
    expect(await screen.findByRole('heading', { name: 'Today screen' })).toBeTruthy();
    expect(where()).toBe('/');
  });

  it('sends a learner who has not onboarded to the welcome screen from any page', async () => {
    await updateSettings({ onboarded: false });
    renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Japanese, together' })).toBeTruthy();
    expect(where()).toBe('/welcome');
  });

  it("doesn't run onboarding again once it's done", async () => {
    renderApp('/welcome');
    expect(await screen.findByRole('heading', { name: 'Today screen' })).toBeTruthy();
    expect(where()).toBe('/');
  });

  it('names each page in the title and announces a change of screen', async () => {
    renderApp('/');
    await screen.findByRole('heading', { name: 'Today screen' });
    expect(document.title).toBe('Issho');
    // The first page of a visit is left to the browser to announce.
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Settings screen' });
    expect(document.title).toBe('Settings · Issho');
    expect(await screen.findByText('Settings', { selector: '[role="status"]' })).toBeTruthy();
  });

  it('names a kanji page with the character, not its percent-encoded path', async () => {
    // A browser's pathname for /kanji/水 is percent-encoded.
    renderApp(`/kanji/${encodeURIComponent('水')}`);
    await screen.findByRole('button', { name: 'Back' });
    expect(document.title).toBe('Kanji 水 · Issho');
  });

  it('names the writing page with its character', async () => {
    renderApp(`/write/${encodeURIComponent('あ')}`);
    await screen.findByRole('heading', { name: 'Write screen' });
    expect(document.title).toBe('Write あ · Issho');
  });

  it('has the v2 tabs: Today, Learn, Library and Together', async () => {
    renderApp('/');
    await screen.findByRole('heading', { name: 'Today screen' });
    const tabs = screen.getByRole('navigation', { name: 'Main' });
    expect([...tabs.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Today', '/'], ['Learn', '/learn'], ['Library', '/library'], ['Together', '/together'],
    ]);
  });

  it('sends the old kanji library address to the library', async () => {
    renderApp('/kanji');
    await screen.findByRole('link', { name: '水' });
    expect(where()).toBe('/library/kanji');
    // A library section keeps the tab bar.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  it('routes can-do checks and together sessions to their screens, without the tab bar', async () => {
    renderApp('/cando/u01-cd1');
    expect(await screen.findByRole('heading', { name: 'Can-do screen' })).toBeTruthy();
    expect(document.title).toBe('Can-do check · Issho');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    cleanup();
    renderApp('/together/session/A');
    expect(await screen.findByRole('heading', { name: 'Together session screen' })).toBeTruthy();
  });

  it("keeps the app (and the tab bar) when a screen's code can't be loaded, and reloads once the app can be reached", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The browser keeps the failed download, so only a fresh page can load it:
    // "Try again" reloads, but not while the app is unreachable.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('<!doctype html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    together.offline = true;
    render(
      <MemoryRouter initialEntries={['/learn']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Learn screen' });
    fireEvent.click(screen.getByRole('link', { name: 'Together' }));

    expect(await screen.findByRole('heading', { level: 1, name: "Couldn't load this screen" })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the app' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Today' }).getAttribute('href')).toBe('/');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Still can't reach the app/)).toBeTruthy();
    expect(reload.page).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(reload.page).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    together.offline = false;
    vi.unstubAllGlobals();
  });

  it('renders a screen again in place when it failed for another reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    grammar.broken = true;
    renderApp('/grammar');
    expect(await screen.findByRole('heading', { level: 1, name: 'Something went wrong on this screen' })).toBeTruthy();
    grammar.broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Grammar screen' })).toBeTruthy();
    expect(reload.page).not.toHaveBeenCalled();
  });
});
