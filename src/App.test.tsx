import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.tsx';

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

afterEach(() => {
  cleanup();
  document.documentElement.scrollTop = 0;
});

describe('App', () => {
  it('opens a new page at the top and leaves back navigation to the browser', async () => {
    render(
      <MemoryRouter initialEntries={['/kanji']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );
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
});
