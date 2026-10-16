import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { exportBackup } from '../../lib/backup.ts';
import { db, updateSettings } from '../../lib/db.ts';
import { DataSection } from './SettingsData.tsx';

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ name: 'Carter', onboarded: true, memberId: 'me', deviceToken: 'token', serverUrl: 'http://home:8787' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('checks a server snapshot first and replaces progress only after confirmation', async () => {
  const now = new Date('2026-10-16T02:00:00Z');
  await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: now });
  await db.cards.put({ ...createEmptyCard(now), id: 'kanji:水|write', itemId: 'kanji:水', kind: 'kanji', type: 'write', stability: 12 });
  const saved = await (await exportBackup()).text();
  await db.cards.update('kanji:水|write', { stability: 99 });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('/api/backups')
    ? JSON.stringify([{ id: 'snapshot', createdAt: now.toISOString(), bytes: saved.length }]) : saved,
  { headers: { 'Content-Type': 'application/json' } })));
  render(<DataSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'Find server backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Restore snapshot from/ }));
  const confirm = await screen.findByRole('button', { name: 'Replace my progress' });
  expect((await db.cards.get('kanji:水|write'))?.stability).toBe(99);
  fireEvent.click(confirm);
  await waitFor(async () => expect((await db.cards.get('kanji:水|write'))?.stability).toBe(12));
  expect(await screen.findByText('Backup restored.')).toBeTruthy();
});
