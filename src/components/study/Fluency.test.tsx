import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import type { AccentInfo, CardRecord, CardType, ItemKind } from '../../lib/types.ts';
import type { NumberDrillItem } from '../../srs/numbersDrill.ts';
import type { PitchItem } from '../../srs/pitch.ts';
import { gradeCard } from '../../srs/scheduler.ts';
import { listen, recognitionAvailable } from '../../speech/recognition.ts';
import { FluencySprint } from './FluencySprint.tsx';
import { PhrasePitchLine, phraseLabels, phraseLevels } from './PhrasePitchLine.tsx';
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
  vi.useRealTimers();
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
    const start = await screen.findByRole('button', { name: 'Start' });
    // The clock stands still until the test moves it; the countdown's own ticks stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    fireEvent.click(start);
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      seen.push(document.querySelector('.st-prompt')!.textContent ?? '');
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(seen.sort()).toEqual(['ありがとう', '水']);
    // The round lasts the full minute: the cards come round again (V059).
    expect(screen.getByText('2 read')).toBeTruthy();
    expect(screen.queryByText(/read in a minute/)).toBeNull();
    const third = document.querySelector('.st-prompt')!.textContent;
    expect(seen).toContain(third);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    act(() => { vi.setSystemTime(t0 + 60_000); });
    expect(await screen.findByText('3 read in a minute')).toBeTruthy();
    await waitFor(async () => expect((await db.fluency.toArray()).map((r) => [r.kind, r.value])).toEqual([['speed', 3]]));
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

describe('fluency plan items (V058)', () => {
  const planned: PitchItem[] = [
    { ref: 'word:w-hon', written: '本', kana: 'ほん', accent: { moras: ['ホ', 'ン'], drop: 1, type: 'atamadaka', withGa: true }, clipRef: 'pitch:word:w-hon' },
    { ref: 'word:w-mizu', written: '水', kana: 'みず', accent: { moras: ['ミ', 'ズ'], drop: 0, type: 'heiban', withGa: true }, clipRef: 'pitch:word:w-mizu' },
  ];

  it('the pitch drill runs the plan’s words, in the plan’s order', async () => {
    render(<FluencySprint plan={{ kind: 'pitch', pitch: planned }} onDone={() => {}} />);
    expect(await screen.findByText('Pitch · 1 / 2')).toBeTruthy();
    await waitFor(() => expect(audioMock.play).toHaveBeenCalledWith({ ref: 'pitch:word:w-hon' }));
    expect(document.querySelector('.st-prompt .st-big')?.textContent).toBe('ほんが');
  });

  it('the planned pitch drill still needs every clip on this phone', async () => {
    audioMock.hasClip.mockImplementationOnce(async () => false);
    render(<FluencySprint plan={{ kind: 'pitch', pitch: planned }} onDone={() => {}} />);
    expect(await screen.findByText(/No pitch drill today/)).toBeTruthy();
  });

  it('the numbers drill runs the plan’s items', async () => {
    const numbers: NumberDrillItem[] = [{ kind: 'number', prompt: '7', answers: ['なな', 'しち'] }];
    render(<FluencySprint plan={{ kind: 'numbers', numbers }} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(document.querySelector('.st-prompt')!.textContent).toBe('7');
  });
});

describe('PhrasePitchLine', () => {
  it('labels the moras in the sentence’s own spelling, not the engine’s katakana (V065, V091)', () => {
    // は and を as written; おとうさん's う, not the オ VOICEVOX hears.
    expect(phraseLabels([['アノ', 0], ['ヒトワ', 2], ['ダレデスカ', 1]], 'あの{人|ひと}はだれですか。'))
      .toEqual([['あ', 'の'], ['ひ', 'と', 'は'], ['だ', 'れ', 'で', 'す', 'か']]);
    expect(phraseLabels([['ウチデ', 0], ['バン', 1], ['ゴハンオ', 1], ['タベマス', 3]], 'うちで{晩|ばん}ご{飯|はん}を{食|た}べます。'))
      .toEqual([['う', 'ち', 'で'], ['ば', 'ん'], ['ご', 'は', 'ん', 'を'], ['た', 'べ', 'ま', 'す']]);
    expect(phraseLabels([['オトオサンニ', 2], ['ヨロシク', 0]], 'お{父|とう}さんによろしく。'))
      .toEqual([['お', 'と', 'う', 'さ', 'ん', 'に'], ['よ', 'ろ', 'し', 'く']]);
    // Katakana words keep their spelling, long-vowel mark included.
    expect(phraseLabels([['コオヒイオ', 3]], 'コーヒーを')).toEqual([['コ', 'ー', 'ヒ', 'ー', 'を']]);
    // A spelling that doesn't line up (an unread kanji, digits), or none: the engine's moras, in hiragana.
    expect(phraseLabels([['キョオワ', 1]], '今日は')).toEqual([['きょ', 'お', 'わ']]);
    expect(phraseLabels([['キョオワ', 1]])).toEqual([['きょ', 'お', 'わ']]);
  });

  it('draws the labels it is given text for', () => {
    const { container } = render(<PhrasePitchLine phrases={[['オトオサンニ', 2], ['ヨロシク', 0]]} text="お{父|とう}さんによろしく。" />);
    expect([...container.querySelectorAll('.st-pitch-mora')].map((t) => t.textContent).join('')).toBe('おとうさんによろしく');
  });

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
