import { cleanup, fireEvent, screen } from '@testing-library/react';
import { State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Library from '../../screens/Library.tsx';
import { addLearned, renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

beforeEach(async () => {
  await resetDb();
  await addLearned('kanji', '日');
  await addLearned('kanji', '一', { lapses: 3 });
  // Freshly learned and never forgotten: low stability alone is not "needs work".
  await addLearned('radical', '氵', { stability: 1, state: State.Learning, reps: 1 });
});

afterEach(cleanup);

const tileNames = () => screen.queryAllByRole('link').map((a) => a.getAttribute('aria-label')).filter((n) => n !== 'Back');

describe('Library', () => {
  it('opens the current phase and marks learned, next-up and later tiles', async () => {
    renderAt('/kanji', '/kanji', <Library />);
    const phase2 = await screen.findByRole('button', { name: /Phase 2 · Foundation/ });
    expect(phase2.getAttribute('aria-expanded')).toBe('true');
    const phase3 = screen.getByRole('button', { name: /Phase 3/ });
    expect(phase3.getAttribute('aria-expanded')).toBe('false');
    // A closed group's panel stays in the page (empty and hidden) so aria-controls always points somewhere.
    expect((document.getElementById(phase3.getAttribute('aria-controls')!) as HTMLElement).hidden).toBe(true);

    expect(tileNames()).toEqual([
      '日, day, learned',
      '一, one, learned, needs work',
      '氵, water, learned',
      '水, water, next up',
      '火, fire, next up',
      '木, tree, next up',
    ]);
    expect(screen.getByRole('link', { name: '水, water, next up' }).getAttribute('href')).toBe(`/kanji/${encodeURIComponent('水')}`);

    // Closed phases render no tiles until opened.
    fireEvent.click(screen.getByRole('button', { name: /Phase 3/ }));
    expect(tileNames()).toContain('金, gold, next up');
    expect(tileNames()).toContain('土, soil, next up');
    fireEvent.click(screen.getByRole('button', { name: /Phase 4/ }));
    expect(tileNames()).toContain('山, mountain, not learned yet');
  });

  it('filters to learned kanji and to the ones that need work', async () => {
    renderAt('/kanji', '/kanji', <Library />);
    await screen.findByRole('button', { name: /Phase 2/ });

    fireEvent.click(screen.getByRole('radio', { name: 'Learned' }));
    expect(tileNames()).toEqual(['日, day, learned', '一, one, learned, needs work', '氵, water, learned']);

    fireEvent.click(screen.getByRole('radio', { name: 'Needs work' }));
    expect(tileNames()).toEqual(['一, one, learned, needs work']);

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(tileNames()).toHaveLength(6);
  });

  it('says so when nothing needs work', async () => {
    await resetDb();
    renderAt('/kanji', '/kanji', <Library />);
    await screen.findByRole('button', { name: /Phase 2/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Needs work' }));
    expect(screen.getByText(/Nothing needs work right now/)).toBeTruthy();
    expect(tileNames()).toEqual([]);
  });
});
