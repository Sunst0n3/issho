import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, updateSettings } from '../../lib/db.ts';
import type { KanaEntry } from '../../lib/types.ts';
import KanjiDetail from '../../screens/KanjiDetail.tsx';
import { chartRows } from './kanaChart.ts';
import { addLearned, renderAt, resetDb } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

beforeEach(resetDb);
afterEach(cleanup);

const renderKanji = (char: string) => renderAt(`/kanji/${encodeURIComponent(char)}`, '/kanji/:char', <KanjiDetail />);

describe('KanjiDetail', () => {
  it('shows meaning, readings with romaji, the memory hook and the unit words', async () => {
    renderKanji('水');
    expect(await screen.findByRole('heading', { level: 1, name: 'water' })).toBeTruthy();
    expect(screen.getByText('みず')).toBeTruthy();
    expect(screen.getByText('mizu')).toBeTruthy();
    expect(screen.getByText('Three drops running beside a stream.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Words with this kanji' })).toBeTruthy();
    // Only learned items can keep an edited hook.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('hides romaji when the learner turned it off', async () => {
    await updateSettings({ romaji: false });
    renderKanji('水');
    expect(await screen.findByText('みず')).toBeTruthy();
    expect(screen.queryByText('mizu')).toBeNull();
  });

  it('learns a kanji out of order, with its words, and then shows its progress', async () => {
    renderKanji('水');
    expect(await screen.findByText('Next up')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Learn this now' }));

    expect(await screen.findByText('Next review')).toBeTruthy();
    expect(await db.items.get('kanji:水')).toBeTruthy();
    expect(await db.items.get('word:w-mizu')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Learn this now' })).toBeNull();
  });

  it('lets a learned kanji keep its own memory hook', async () => {
    await db.items.add({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() });
    renderKanji('水');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Your memory hook'), { target: { value: 'A river with splashes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A river with splashes.')).toBeTruthy();
    expect((await db.items.get('kanji:水'))?.customMnemonic).toBe('A river with splashes.');

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(await screen.findByRole('button', { name: 'Show memory hook' })).toBeTruthy();
    expect((await db.items.get('kanji:水'))?.hideMnemonic).toBe(true);
  });

  it('shows a part (radical) with the kanji built from it', async () => {
    renderKanji('氵');
    expect(await screen.findByRole('heading', { level: 1, name: 'water (side)' })).toBeTruthy();
    expect(screen.getByText(/Means “water”/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '水' }).getAttribute('href')).toBe(`/kanji/${encodeURIComponent('水')}`);
  });

  it('handles a kanji with no memory hook, no words and no stroke data', async () => {
    await addLearned('kanji', '火');
    renderKanji('火');
    expect(await screen.findByRole('heading', { level: 1, name: 'fire' })).toBeTruthy();
    expect(await screen.findByText('No stroke order for this character yet.')).toBeTruthy();
    expect(screen.queryByText('Memory hook')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Words with this kanji' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Practice writing' })).toBeNull();
    // A learned kanji without a stock hook can still get one of the learner's own.
    fireEvent.click(await screen.findByRole('button', { name: 'Write your own memory hook' }));
    expect(screen.getByLabelText('Your memory hook')).toBeTruthy();
  });

  it("explains when a character isn't in the course", async () => {
    renderKanji('龍');
    expect(await screen.findByRole('heading', { name: /isn't in the course/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the kanji library' }).getAttribute('href')).toBe('/kanji');
  });

  it("shows a learned part's progress instead of offering to learn it", async () => {
    await addLearned('radical', '氵');
    renderKanji('氵');
    expect(await screen.findByRole('heading', { level: 1, name: 'water (side)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Learn this now' })).toBeNull();
    expect(await screen.findByText('Next review')).toBeTruthy();
  });

  it("doesn't show the previous kanji's page after moving to another one", async () => {
    function GoTo({ char }: { char: string }) {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(`/kanji/${encodeURIComponent(char)}`)}>Go to {char}</button>;
    }
    render(
      <MemoryRouter initialEntries={[`/kanji/${encodeURIComponent('水')}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GoTo char="火" />
        <Routes><Route path="/kanji/:char" element={<KanjiDetail />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'water' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Learn this now' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Go to 火' }));
    // 水's meaning, hook and "Learn this now" (which would add 水) must not linger under 火.
    expect(screen.queryByRole('heading', { level: 1, name: 'water' })).toBeNull();
    expect(screen.queryByText('Three drops running beside a stream.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Learn this now' })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'fire' })).toBeTruthy();
  });
});

describe('chartRows', () => {
  const kana = (char: string, romaji: string, group: string, order: number): KanaEntry =>
    ({ char, romaji, group, order, script: 'hiragana', kind: 'basic' });

  it('puts each kana under its vowel and leaves the gaps of the chart', () => {
    const rows = chartRows([
      kana('や', 'ya', 'ya', 0), kana('ゆ', 'yu', 'ya', 1), kana('よ', 'yo', 'ya', 2),
      kana('わ', 'wa', 'wa', 3), kana('を', 'wo', 'wa', 4),
      kana('ん', 'n', 'n', 5),
      kana('し', 'shi', 'sa', 6), kana('つ', 'tsu', 'ta', 7),
    ], 'aiueo');
    const chars = rows.map((r) => r.map((e) => e?.char ?? '·').join(''));
    expect(chars).toEqual(['や·ゆ·よ', 'わ···を', 'ん····', '·し···', '··つ··']);
  });
});
