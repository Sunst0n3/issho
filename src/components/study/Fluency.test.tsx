import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import type { AccentInfo, CardRecord, CardType, ItemKind } from '../../lib/types.ts';
import type { NumberDrillItem } from '../../srs/numbersDrill.ts';
import type { PitchItem } from '../../srs/pitch.ts';
import { gradeCard } from '../../srs/scheduler.ts';
import { listen, recognitionAvailable } from '../../speech/recognition.ts';
import { FluencySprint } from './FluencySprint.tsx';
import { PhrasePitchLine, phraseLevels } from './PhrasePitchLine.tsx';
import { accentType, PitchDrill } from './PitchDrill.tsx';
import { moraLevels, PitchLine } from './PitchLine.tsx';
import { audioMock, resetStudyDb } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);
vi.mock('../../srs/scheduler.ts', async (original) => ({
  ...(await original<typeof import('../../srs/scheduler.ts')>()),
  gradeCard: vi.fn(),
}));
vi.mock('../../srs/fluency.ts', async (original) => ({
  ...(await original<typeof import('../../srs/fluency.ts')>()),
  numbersDrillToday: vi.fn(async (): Promise<NumberDrillItem[]> => [
    { kind: 'number', prompt: '300', answers: ['さんびゃく'] },
    { kind: 'counter', prompt: '3本', answers: ['さんぼん'] },
    { kind: 'price', prompt: '¥1,500', answers: ['せんごひゃくえん'] },
  ]),
}));
vi.mock('../../speech/recognition.ts', () => ({ recognitionAvailable: vi.fn(() => false), listen: vi.fn() }));

function card(kind: ItemKind, key: string, type: CardType, stability: number): CardRecord {
  const itemId = `${kind}:${key}`;
  return { ...createEmptyCard(new Date()), state: 2, reps: 6, stability, id: cardId(itemId, type), itemId, kind, type };
}

beforeEach(async () => {
  await resetStudyDb();
  vi.mocked(recognitionAvailable).mockReturnValue(false);
  audioMock.play.mockClear();
  audioMock.play.mockImplementation(async () => ({ via: 'clip' as const, ms: 900, interrupted: false }));
});

afterEach(() => {
  cleanup();
});

describe('speed round', () => {
  it('shows only well-known receptive cards (stability > 21 d), counts them, logs the round and never grades', async () => {
    await db.cards.bulkPut([
      card('word', 'w-mizu', 'read', 40),
      card('core', 'cw-0001', 'listen', 30),
      card('word', 'w-ike', 'read', 5),
      card('kanji', '水', 'write', 60),
    ]);
    const onDone = vi.fn();
    render(<FluencySprint plan={{ kind: 'speed' }} onDone={onDone} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      seen.push(document.querySelector('.st-prompt')!.textContent ?? '');
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(seen.sort()).toEqual(['ありがとう', '水']);
    expect(await screen.findByText('2 read in a minute')).toBeTruthy();
    await waitFor(async () => expect((await db.fluency.toArray()).map((r) => [r.kind, r.value])).toEqual([['speed', 2]]));
    expect(gradeCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

/** A recognition attempt that hears `text`. */
function hears(text: string) {
  vi.mocked(listen).mockReturnValueOnce({ result: Promise.resolve(text), stop: vi.fn() });
}

describe('numbers drill', () => {
  it('takes typed answers against the clock, logs the right ones and never grades', async () => {
    const onDone = vi.fn();
    render(<FluencySprint plan={{ kind: 'numbers' }} onDone={onDone} />);
    expect(await screen.findByText('Type how each one is said, as many as you can.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.queryByRole('button', { name: 'Say it' })).toBeNull();
    const field = screen.getByRole('textbox', { name: 'How is it said?' });
    fireEvent.change(field, { target: { value: 'sanbyaku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Right')).toBeTruthy();
    // The same field stays for the next item (a new one would close the phone's keyboard).
    expect(screen.getByRole('textbox', { name: 'How is it said?' })).toBe(field);
    fireEvent.change(field, { target: { value: 'sanhon' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('status').textContent).toBe('3本: さんぼん');
    fireEvent.change(field, { target: { value: 'sengohyakuen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('2 right in a minute')).toBeTruthy();
    await waitFor(async () => expect((await db.fluency.toArray()).map((r) => [r.kind, r.value])).toEqual([['numbers', 2]]));
    expect(gradeCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('can be said: a number written in digits counts, a mishearing is shown and can be tried again', async () => {
    vi.mocked(recognitionAvailable).mockReturnValue(true);
    render(<FluencySprint plan={{ kind: 'numbers' }} onDone={() => {}} />);
    expect(await screen.findByText('Say or type how each one is said, as many as you can.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    hears('300');
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    expect(await screen.findByText('Right')).toBeTruthy();
    expect(document.querySelector('.st-prompt')!.textContent).toBe('3本');
    hears('3枚');
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    expect(await screen.findByText(/Heard/)).toBeTruthy();
    expect(document.querySelector('.st-prompt')!.textContent).toBe('3本');
    hears('三本');
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    await waitFor(() => expect(document.querySelector('.st-prompt')!.textContent).toBe('¥1,500'));
    expect(screen.getByText('2 right')).toBeTruthy();
  });

  it('an answer typed while the mic is open closes it, and what it heard is not given to the next item', async () => {
    vi.mocked(recognitionAvailable).mockReturnValue(true);
    let heard: (text: string) => void = () => {};
    const stop = vi.fn();
    vi.mocked(listen).mockReturnValueOnce({ result: new Promise<string>((resolve) => { heard = resolve; }), stop });
    render(<FluencySprint plan={{ kind: 'numbers' }} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    expect(screen.getByRole('button', { name: /Listening/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Or type how it is said' }), { target: { value: 'sanbyaku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Say it' })).toBeTruthy();
    // The late transcript happens to be the next item's answer: it must not count.
    heard('三本');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.st-prompt')!.textContent).toBe('3本');
    expect(screen.getByText('1 right')).toBeTruthy();
    expect(screen.queryByText(/Heard/)).toBeNull();
  });
});

describe('PitchLine', () => {
  const accent = (moras: string[], drop: number): AccentInfo => ({ moras, drop, type: accentType(drop, moras.length), withGa: true });

  it('puts each mora high or low by the accent nucleus, and the particle after it', () => {
    expect(moraLevels(3, 0)).toEqual({ moras: [false, true, true], particle: true });
    expect(moraLevels(3, 1)).toEqual({ moras: [true, false, false], particle: false });
    expect(moraLevels(4, 2)).toEqual({ moras: [false, true, false, false], particle: false });
    expect(moraLevels(3, 3)).toEqual({ moras: [false, true, true], particle: false });
    expect(accentType(0, 3)).toBe('heiban');
    expect(accentType(1, 3)).toBe('atamadaka');
    expect(accentType(2, 4)).toBe('nakadaka');
    expect(accentType(3, 3)).toBe('odaka');
  });

  it.each([
    ['heiban', ['サ', 'ク', 'ラ'], 0, 'さくら'],
    ['atamadaka', ['ハ', 'シ'], 1, 'はし'],
    ['nakadaka', ['ア', 'リ', 'ガ', 'ト', 'ー'], 2, 'ありがとー'],
    ['odaka', ['ハ', 'シ'], 2, 'はし'],
  ])('draws a %s word as a height line (snapshot)', (type, moras, drop, kana) => {
    const { container } = render(<PitchLine accent={accent(moras, drop)} kana={kana} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-type')).toBe(type);
    // Only heiban and odaka get the particle dot that tells them apart.
    expect(svg.querySelectorAll('.st-pitch-dot.particle')).toHaveLength(type === 'heiban' || type === 'odaka' ? 1 : 0);
    expect(svg.textContent).not.toMatch(/[HL]/);
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe('PhrasePitchLine', () => {
  it('draws one small line per accent phrase (snapshot)', () => {
    expect(phraseLevels(4, 1)).toEqual([true, false, false, false]);
    expect(phraseLevels(4, 4)).toEqual([false, true, true, true]);
    expect(phraseLevels(5, 3)).toEqual([false, true, true, false, false]);
    const { container } = render(<PhrasePitchLine phrases={[['キョーワ', 1], ['イー', 2], ['テンキデス', 1]]} />);
    expect(container.querySelectorAll('.st-pitch-phrase')).toHaveLength(3);
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe('PitchDrill', () => {
  const items: PitchItem[] = [
    { ref: 'word:w-mizu', written: '水', kana: 'みず', accent: { moras: ['ミ', 'ズ'], drop: 0, type: 'heiban', withGa: true }, clipRef: 'pitch:word:w-mizu' },
    { ref: 'word:w-hon', written: '本', kana: 'ほん', accent: { moras: ['ホ', 'ン'], drop: 1, type: 'atamadaka', withGa: true }, clipRef: 'pitch:word:w-hon' },
  ];

  it('plays the word + が clip, draws n + 1 moras per option, and gives feedback on a tap', async () => {
    const onDone = vi.fn();
    render(<PitchDrill items={items} onDone={onDone} />);
    await waitFor(() => expect(audioMock.play).toHaveBeenCalledWith({ ref: 'pitch:word:w-mizu' }));
    const options = within(screen.getByRole('group', { name: 'Pitch options' })).getAllByRole('button');
    expect(options).toHaveLength(3);
    for (const option of options) {
      const labels = [...option.querySelectorAll('.st-pitch-mora')].map((t) => t.textContent);
      expect(labels).toEqual(['み', 'ず', 'が']);
    }
    fireEvent.click(options.find((o) => o.getAttribute('data-drop') === '0')!);
    expect(screen.getByText('Yes')).toBeTruthy();
    await waitFor(async () => expect(await db.pitchBoxes.get('word:w-mizu')).toMatchObject({ box: 1, correct: 1 }));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(audioMock.play).toHaveBeenCalledWith({ ref: 'pitch:word:w-hon' }));
    const second = within(screen.getByRole('group', { name: 'Pitch options' })).getAllByRole('button');
    fireEvent.click(second.find((o) => o.getAttribute('data-drop') === '0')!);
    expect(screen.getByText('Not quite: listen once more')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect((await db.fluency.toArray()).map((r) => [r.kind, r.value])).toEqual([['pitch', 1]]));
  });
});
