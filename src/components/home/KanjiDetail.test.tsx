import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db.ts';
import type { KanaEntry } from '../../lib/types.ts';
import KanjiDetail, { wordLines } from '../../screens/KanjiDetail.tsx';
import { chartRows } from './kanaChart.ts';
import { MNEMONIC_MAX } from './KanjiParts.tsx';
import { partsOf } from './PartsPanel.tsx';
import { addLearned, ACCENT, CURRICULUM, KANJI, RADICALS, renderAt, resetDb, WORDS } from './test-fixtures.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-fixtures.tsx')).dataMock);

const mocks = vi.hoisted(() => ({
  setPinned: vi.fn(async (_char: string, _pinned: boolean) => {}),
  play: vi.fn(async () => ({ via: 'clip', ms: 300, interrupted: false })),
}));

vi.mock('../../srs/items.ts', () => ({ setPinned: mocks.setPinned }));
vi.mock('../../speech/audio.ts', () => ({
  usePlayback: () => ({ play: mocks.play, stop: () => {}, playing: false }),
}));
vi.mock('../study/PitchLine.tsx', () => ({
  PitchLine: ({ accent, kana }: { accent: { type: string }; kana?: string }) => (
    <span data-testid="pitch">{`${kana ?? ''} ${accent.type}`}</span>
  ),
}));

beforeEach(resetDb);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderKanji = (char: string) => renderAt(`/kanji/${encodeURIComponent(char)}`, '/kanji/:char', <KanjiDetail />);

describe('KanjiDetail', () => {
  it('shows the keyword and readings in kana only (no romaji), with JLPT as a label', async () => {
    renderKanji('水');
    expect(await screen.findByRole('heading', { level: 1, name: 'water' })).toBeTruthy();
    expect(screen.getAllByText('みず').length).toBeGreaterThan(0);
    expect(screen.getByText('スイ')).toBeTruthy();
    expect(screen.queryByText(/mizu|sui\b/)).toBeNull();
    expect(screen.getByText('Old JLPT 4')).toBeTruthy();
    expect(screen.getByText('Chapter 1')).toBeTruthy();
  });

  it('names the parts: kanji components and named parts', async () => {
    renderKanji('休');
    const parts = (await screen.findByRole('heading', { name: 'Parts' })).closest('section')!;
    expect(within(parts).getByRole('link', { name: '木, tree' }).getAttribute('href')).toBe(`/kanji/${encodeURIComponent('木')}`);
    expect(within(parts).getByRole('link', { name: '亻, person (side)' })).toBeTruthy();
    expect(parts.textContent).toContain('a form of 人');
  });

  it('lists the anchor and staged words, then related words with the kanji, known ones first', async () => {
    await db.items.add({ id: 'word:w-honjitsu', kind: 'word', key: 'w-honjitsu', introducedAt: new Date() });
    renderKanji('日');
    const words = (await screen.findByRole('heading', { name: 'Words with this kanji' })).closest('section')!;
    const lines = within(words).getAllByRole('listitem').map((li) => li.querySelector('.kd-word-written')?.textContent);
    // Anchor 日, staged 日曜日, then 本日 (known) before 毎日 and 水曜日 (more frequent, not known).
    expect(lines).toEqual(['日', '日曜日', '本日', '毎日', '水曜日']);
    expect(words.textContent).toContain('Learned with this kanji');
    expect(words.textContent).toContain('Comes a few days after it');
  });

  it('draws a pitch line for words with a verified accent, and plays the word clip', async () => {
    renderKanji('日');
    const words = (await screen.findByRole('heading', { name: 'Words with this kanji' })).closest('section')!;
    expect(within(words).getAllByTestId('pitch').map((p) => p.textContent)).toEqual(['ひ atamadaka']);
    fireEvent.click(within(words).getByRole('button', { name: 'Listen to 日' }));
    expect(mocks.play).toHaveBeenCalledWith({ ref: 'word:w-hi' }, expect.objectContaining({ fallbackText: '{日|ひ}' }));
  });

  it('pins a learned kanji to keep it in handwriting, and unpins it', async () => {
    await addLearned('水');
    renderKanji('水');
    const pin = await screen.findByRole('switch', { name: /Keep in handwriting/ });
    expect((pin as HTMLInputElement).checked).toBe(false);
    fireEvent.click(pin);
    await waitFor(() => expect(mocks.setPinned).toHaveBeenCalledWith('水', true));

    cleanup();
    await db.items.update('kanji:水', { pinned: true });
    renderKanji('水');
    const pinned = await screen.findByRole('switch', { name: /Keep in handwriting/ });
    expect((pinned as HTMLInputElement).checked).toBe(true);
    fireEvent.click(pinned);
    await waitFor(() => expect(mocks.setPinned).toHaveBeenCalledWith('水', false));
  });

  it('offers practice writing on its own page, and no pin before the kanji is learned', async () => {
    renderKanji('水');
    expect((await screen.findByRole('link', { name: /Practice writing/ })).getAttribute('href')).toBe(`/write/${encodeURIComponent('水')}`);
    expect(screen.queryByRole('switch', { name: /Keep in handwriting/ })).toBeNull();
    expect(await screen.findByText('Next up')).toBeTruthy();
  });

  it('shows the card status, with "reading only" once the write card retired', async () => {
    await addLearned('日', { suspended: 'retired' });
    renderKanji('日');
    const status = await screen.findByRole('region', { name: 'Your progress' });
    expect(status.textContent).toContain('Reading only');
  });

  it('shows the stock hook with its sound hook, and keeps a learner\'s own', async () => {
    await db.items.add({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date() });
    renderKanji('水');
    expect(await screen.findByText('Three drops running beside a stream.')).toBeTruthy();
    expect(screen.getByText(/me, zoo, splash/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Your memory hook'));
    expect(screen.getByLabelText('Your memory hook').getAttribute('maxlength')).toBe(String(MNEMONIC_MAX));
    fireEvent.change(screen.getByLabelText('Your memory hook'), { target: { value: 'A river with splashes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A river with splashes.', { selector: '.kd-hook-text' })).toBeTruthy();
    expect((await db.items.get('kanji:水'))?.customMnemonic).toBe('A river with splashes.');
  });

  it('lets a learned kanji without a stock hook get one of the learner\'s own', async () => {
    await addLearned('火');
    renderKanji('火');
    fireEvent.click(await screen.findByRole('button', { name: 'Write your own memory hook' }));
    expect(screen.getByLabelText('Your memory hook')).toBeTruthy();
  });

  it('shows a named part with the kanji built from it', async () => {
    renderKanji('亻');
    expect(await screen.findByRole('heading', { level: 1, name: 'person (side)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '休, rest' })).toBeTruthy();
  });

  it("explains when a character isn't in the course, and goes back to the library", async () => {
    renderKanji('龍');
    expect(await screen.findByRole('heading', { name: /isn't in the course/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the library' }).getAttribute('href')).toBe('/library');
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/library');
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
    fireEvent.click(screen.getByRole('button', { name: 'Go to 火' }));
    expect(screen.queryByRole('heading', { level: 1, name: 'water' })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'fire' })).toBeTruthy();
  });
});

describe('kanji page helpers', () => {
  it('orders words: anchor, staged, then known related, then by frequency (max 8 related)', () => {
    const unit = CURRICULUM.units.find((u) => u.char === '水');
    const info = (ref: string) => ({ ref, written: ref, kana: '', en: '', kanji: [], use: false, readings: [] }) as never;
    const lines = wordLines(unit, '水', WORDS, info, new Set(), ACCENT);
    expect(lines.map((l) => [l.info.ref, l.role])).toEqual([['core:cw-0005', 'anchor'], ['word:w-suiyou', 'staged']]);
    // 水 as a JMdict entry is the core word cw-0005 (one identity per word), so it isn't listed twice.
    expect(lines[0].accent?.type).toBe('heiban');
  });

  it('lists components before named parts, without the kanji itself', () => {
    const radicals = new Map(RADICALS.map((r) => [r.char, r]));
    expect(partsOf(KANJI['休'], KANJI, radicals).map((p) => [p.char, p.name, p.kanji])).toEqual([
      ['木', 'tree', true],
      ['亻', 'person (side)', false],
    ]);
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
