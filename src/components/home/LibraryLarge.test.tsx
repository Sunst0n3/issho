// The library at full size (2,136 kanji in 143 chapters): the first render must stay small.
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Curriculum, CurriculumUnit, KanjiEntry } from '../../lib/types.ts';
import Library from '../../screens/Library.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => {
  const fixtures = (await import('./test-fixtures.tsx')).dataMock;
  const units: CurriculumUnit[] = [];
  const kanji: Record<string, KanjiEntry> = {};
  for (let i = 0; i < 2136; i++) {
    const char = String.fromCodePoint(0x4e00 + i);
    units.push({ index: i, char, anchor: null, staged: [], inferable: false, chapter: Math.floor(i / 15) + 1 });
    kanji[char] = { char, meanings: [`meaning ${i + 1}`], kun: [], on: [], strokeCount: 4, components: [], parts: [], rank: i + 1 };
  }
  const curriculum: Curriculum = { version: 2, units, confusables: [] };
  return { ...fixtures, loadCurriculum: async () => curriculum, loadKanji: async () => kanji };
});

beforeEach(resetDb);
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const tiles = () => document.querySelectorAll('.lib-tile').length;

it('renders the open chapter only, and the others when asked for', async () => {
  renderAt('/library', '/library', <Library />);
  const summary = await screen.findByText(/0 kanji learned so far/);
  // Chapters carry the counts; nothing counts toward the whole 2,136.
  expect(summary.textContent).not.toMatch(/2,136|2136/);
  expect(screen.getAllByRole('button', { name: /^Chapter \d+,/ })).toHaveLength(143);
  expect(tiles()).toBe(15);
  fireEvent.click(screen.getByRole('button', { name: /^Chapter 143,/ }));
  expect(tiles()).toBe(15 + 6);
});
