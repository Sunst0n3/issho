// The library at full size (2,000+ units): the first render must stay small.
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Curriculum, CurriculumUnit, KanjiEntry } from '../../lib/types.ts';
import Library from '../../screens/Library.tsx';
import { renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => {
  const fixtures = (await import('./test-fixtures.tsx')).dataMock;
  const sizes = { 2: 354, 3: 517, 4: 1340 };
  const units: CurriculumUnit[] = [];
  const kanji: Record<string, KanjiEntry> = {};
  for (const [phase, count] of Object.entries(sizes)) {
    for (let i = 0; i < count; i++) {
      const char = String.fromCodePoint(0x4e00 + units.length);
      units.push({ index: units.length, type: 'kanji', char, phase: Number(phase), words: [] });
      kanji[char] = { char, meanings: [`meaning ${units.length}`], kun: [], on: [], strokeCount: 4, components: [] };
    }
  }
  const curriculum: Curriculum = { units, phaseEnds: { 2: 354, 3: 871, 4: units.length } };
  return { ...fixtures, loadCurriculum: async () => curriculum, loadKanji: async () => kanji, loadRadicals: async () => [] };
});

beforeEach(resetDb);
afterEach(cleanup);

const tiles = () => document.querySelectorAll('.lib-tile').length;

it('renders one page of the open phase and nothing of the closed ones', async () => {
  renderAt('/kanji', '/kanji', <Library />);
  expect(await screen.findByText(/0 of 2,211 kanji learned/)).toBeTruthy();
  expect(tiles()).toBe(180);

  fireEvent.click(screen.getByRole('button', { name: 'Show 174 more' }));
  expect(tiles()).toBe(354);
  expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /Phase 4/ }));
  expect(tiles()).toBe(354 + 180);
});
