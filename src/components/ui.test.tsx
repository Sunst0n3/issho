import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon, ProgressBar, Ruby, TopBar } from './ui.tsx';

afterEach(cleanup);

function Forward() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(1)}>Browser forward</button>;
}
function BrowserBack() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Browser back</button>;
}

function renderSettings(entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<p>Home screen</p>} />
        <Route path="/settings" element={<TopBar back="/" title="Settings" />} />
      </Routes>
      <Forward />
      <BrowserBack />
    </MemoryRouter>,
  );
}

describe('TopBar', () => {
  it('renders a text title as the page h1, or as plain text when asked', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TopBar title="Grammar" />
        <TopBar heading={false} title={<ProgressBar value={0.5} label="Quiz progress" />} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Grammar']);
    expect(screen.getByRole('progressbar', { name: 'Quiz progress' }).closest('h1')).toBeNull();
  });

  it('goes back in history when the page was opened from inside the app', async () => {
    renderSettings(['/', '/settings']);
    fireEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    // Back, not a new page: Settings is still ahead in history, and nothing piles up behind.
    fireEvent.click(screen.getByRole('button', { name: 'Browser forward' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('replaces the page with its fallback when opened directly', async () => {
    renderSettings(['/settings']);
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/');
    fireEvent.click(screen.getByRole('link', { name: 'Back' }));
    expect(await screen.findByText('Home screen')).toBeTruthy();
    // Replaced, so the back gesture doesn't reopen Settings.
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(screen.getByText('Home screen')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });
});

describe('Ruby', () => {
  it('passes each segment\'s base and reading to a show predicate', () => {
    const seen: Array<[string, string | undefined]> = [];
    render(<Ruby text="{食|た}べる{水|みず}" show={(base, reading) => { seen.push([base, reading]); return base === '水'; }} />);
    expect(seen).toEqual([['食', 'た'], ['水', 'みず']]);
    expect(document.querySelectorAll('rt')).toHaveLength(1);
    expect(document.querySelector('rt')?.textContent).toBe('みず');
  });

  it("keeps working with a predicate that only reads the base, and with 'all' and 'none'", () => {
    const { container, rerender } = render(<Ruby text="{明日|あした}" show={(base) => base.length > 1} />);
    expect(container.querySelectorAll('rt')).toHaveLength(1);
    rerender(<Ruby text="{明日|あした}" show="none" />);
    expect(container.querySelectorAll('rt')).toHaveLength(0);
    rerender(<Ruby text="{明日|あした}" />);
    expect(container.querySelectorAll('rt')).toHaveLength(1);
  });
});

describe('Icon', () => {
  it.each(['rest', 'travel', 'repair', 'pitch', 'quest'] as const)('draws the %s icon', (name) => {
    const { container } = render(<Icon name={name} />);
    expect(container.querySelector('path')?.getAttribute('d')).toBeTruthy();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
