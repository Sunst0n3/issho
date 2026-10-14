import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePlay } from '../../lib/types.ts';
import RolePlayList from '../../screens/RolePlayList.tsx';

const roles = { a: { name: 'A', nameJp: 'え' }, b: { name: 'B', nameJp: 'び' } };
const SCRIPTS: RolePlay[] = [
  { id: 'rp-1', title: 'Good morning', titleJp: 'おはよう', level: 1, setting: 'Morning.', roles, lines: [] },
  {
    id: 'rp-2', title: 'At the station', titleJp: 'えきで', level: 2, setting: 'Buying a ticket.', roles,
    lines: [{ role: 'a', jp: 'きっぷを ください。', en: 'A ticket, please.' }, { role: 'b', jp: 'はい。', en: 'Here.' }],
  },
];

vi.mock('../../lib/data.ts', () => ({ loadRolePlays: async () => SCRIPTS }));
vi.mock('../../srs/course.ts', () => ({ currentPhase: async () => 2 }));

afterEach(cleanup);

describe('RolePlayList', () => {
  it('has one h1, and names its headings and rows with the parts kept apart', async () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><RolePlayList /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1, name: 'Role-plays' })).toBeTruthy();

    // "For you now" sits beside the level heading, not run into it.
    expect(await screen.findByText('For you now')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Level 2 · Everyday' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Level 2 · Everyday' })).toBeTruthy();

    const row = screen.getByRole('link', { name: 'At the station えきで Buying a ticket. 2 lines' });
    expect(row.getAttribute('href')).toBe('/roleplay/rp-2');
  });
});
