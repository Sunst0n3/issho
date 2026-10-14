import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../../lib/db.ts';
import LearnHub from '../../screens/LearnHub.tsx';
import { addLearned, renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

beforeEach(async () => {
  await resetDb();
  await updateSettings({ onboarded: true, name: 'Sam' });
});
afterEach(cleanup);

describe('LearnHub', () => {
  it('labels the two kana counts so they read as different measures', async () => {
    // Phase 1 with two hiragana learned: 2 of the basic kana that unlock phase 2, 2 of all kana.
    for (const char of ['あ', 'い']) await db.items.add({ id: `kana:${char}`, kind: 'kana', key: char, introducedAt: new Date() });
    renderAt('/learn', '/learn', <LearnHub />);
    expect(await screen.findByText('2 of 10 basic kana')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Kana chart, 2 of 10 kana learned' })).toBeTruthy();
  });

  it('names each study area with its line of detail, separated', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await addLearned('kanji', '日');
    renderAt('/learn', '/learn', <LearnHub />);
    expect(await screen.findByRole('link', { name: 'Kanji library, 1 kanji learned · 8 in all' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Grammar, 0 of 0 learned' })).toBeTruthy();
    expect(screen.getByText('1 of 5 kanji')).toBeTruthy();
  });
});
