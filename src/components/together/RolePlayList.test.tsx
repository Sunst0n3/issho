import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberProgress } from '../../../shared/api.ts';
import { db } from '../../lib/db.ts';
import type { CoreWord, GrammarPoint, RolePlay, UnitSpec } from '../../lib/types.ts';
import RolePlayList from '../../screens/RolePlayList.tsx';

const roles = { a: { name: 'A', nameJp: 'え' }, b: { name: 'B', nameJp: 'び' } };
const script = (patch: Partial<RolePlay> & Pick<RolePlay, 'id' | 'title' | 'level'>): RolePlay => ({
  titleJp: patch.title, setting: '', register: 'plain', targets: [], roles, lines: [], ...patch,
});
const SCRIPTS: RolePlay[] = [
  // A unit's core conversation: Session A runs it in stages, never the free list.
  script({ id: 'rp-u01', title: 'Hello again', level: 1, unit: 1 }),
  script({ id: 'rp-1', title: 'Good morning', titleJp: 'おはよう', level: 1, unit: 1, setting: 'Morning.', targets: ['core:cw-1'] }),
  script({
    id: 'rp-2', title: 'At the station', titleJp: 'えきで', level: 2, setting: 'Buying a ticket.',
    targets: ['core:cw-1', 'core:cw-2'],
    lines: [
      { role: 'a', jp: 'きっぷを ください。', en: 'A ticket, please.', cue: 'ticket · please' },
      { role: 'b', jp: 'はい。', en: 'Here.', cue: '' },
    ],
  }),
  // Three targets not introduced for both partners.
  script({ id: 'rp-3', title: 'At the bank', level: 2, targets: ['core:cw-2', 'core:cw-3', 'grammar:g-2'] }),
  // A unit far beyond the couple's.
  script({ id: 'rp-4', title: 'A job interview', level: 3, unit: 12 }),
];
const UNITS = [{ id: 1, conversation: 'rp-u01' }] as unknown as UnitSpec[];
const CORE = new Map<string, Pick<CoreWord, 'order'>>([['cw-1', { order: 1 }], ['cw-2', { order: 2 }], ['cw-3', { order: 3 }]]);
const GRAMMAR = new Map<string, Pick<GrammarPoint, 'order'>>([['g-2', { order: 2 }]]);

const mocks = vi.hoisted(() => ({ partner: null as MemberProgress | null }));
vi.mock('../../lib/data.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/data.ts')>()),
  loadRolePlays: async () => SCRIPTS,
  loadUnits: async () => UNITS,
  loadCoreIndex: async () => CORE,
  loadGrammarIndex: async () => GRAMMAR,
}));
vi.mock('../../srs/memberProgress.ts', () => ({ memberProgress: async () => ({ settledUnit: 1 }) }));
vi.mock('../../sync/stats.ts', () => ({
  useHousehold: () => ({
    loading: false,
    refresh: async () => {},
    data: mocks.partner && {
      me: 'me',
      members: [
        { member: { id: 'me', name: 'Aiko', joinedAt: '', lastSeenAt: null }, progress: null, days: [] },
        { member: { id: 'ken', name: 'Ken', joinedAt: '', lastSeenAt: null }, progress: mocks.partner, days: [] },
      ],
    },
  }),
}));

function renderList() {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><RolePlayList /></MemoryRouter>);
}

beforeEach(async () => {
  await db.items.clear();
  // This phone introduced cw-1 only.
  await db.items.put({ id: 'core:cw-1', kind: 'core', key: 'cw-1', introducedAt: new Date() });
  mocks.partner = { coreReached: 3, grammarReached: 0, settledUnit: 1 } as MemberProgress;
});

afterEach(cleanup);

describe('RolePlayList', () => {
  it('lists only free role-plays that fit what both partners know', async () => {
    renderList();
    expect(await screen.findByText('Good morning')).toBeTruthy();
    expect(screen.getByText('At the station')).toBeTruthy();
    expect(screen.queryByText('Hello again')).toBeNull();
    expect(screen.queryByText('At the bank')).toBeNull();
    expect(screen.queryByText('A job interview')).toBeNull();
  });

  it('has one h1, and names its headings and rows with the parts kept apart', async () => {
    renderList();
    expect(screen.getByRole('heading', { level: 1, name: 'Role-plays' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'Level 2 · Everyday' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Level 2 · Everyday' })).toBeTruthy();

    const row = screen.getByRole('link', { name: 'At the station えきで Buying a ticket. 2 lines' });
    expect(row.getAttribute('href')).toBe('/roleplay/rp-2');
  });

  it('goes by this phone alone when there is no partner', async () => {
    mocks.partner = null;
    renderList();
    expect(await screen.findByText('Good morning')).toBeTruthy();
    expect(screen.getByText('At the station')).toBeTruthy();
    expect(screen.queryByText('At the bank')).toBeNull();
  });
});
