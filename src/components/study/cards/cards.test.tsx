import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createEmptyCard, Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import type { CardRecord, CardType, ItemKind } from '../../../lib/types.ts';
import { seededRandom } from '../../../srs/random.ts';
import { listen, recognitionAvailable } from '../../../speech/recognition.ts';
import { StudyDisplayContext } from '../display.ts';
import { audioMock, KANA, resetStudyDb, TAUGHT_DAY_3 } from '../test-utils.tsx';
import { KanaInput } from './KanaInput.tsx';
import { KanaText } from './KanaText.tsx';
import { prepareCard, type PrepareContext } from './prepare.ts';
import { ReviewCard } from './ReviewCard.tsx';
import type { CardAnswer, PreparedCard } from './types.ts';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../writing/WritingPad.tsx', async () => (await import('../test-utils.tsx')).writingPadMock);
vi.mock('../../../speech/audio.ts', async () => (await import('../test-utils.tsx')).audioMock);
vi.mock('../../../speech/recognition.ts', () => ({ recognitionAvailable: vi.fn(() => false), listen: vi.fn() }));

const known = { isKnown: () => true, introducedDay: () => '2026-10-01' };
const ctx = (over: Partial<PrepareContext> = {}): PrepareContext =>
  ({ courseDay: 20, inSprint: false, taught: new Set(), grammarIntroduced: 5, handsBusy: false, known, random: seededRandom(4), ...over });

function card(kind: ItemKind, key: string, type: CardType): CardRecord {
  const itemId = `${kind}:${key}`;
  return { ...createEmptyCard(new Date()), id: cardId(itemId, type), itemId, kind, type };
}

async function prep(kind: ItemKind, key: string, type: CardType, over: Partial<PrepareContext> = {}): Promise<PreparedCard> {
  const p = await prepareCard(card(kind, key, type), ctx(over));
  if (!p) throw new Error('missing');
  return p;
}

function show(prepared: PreparedCard, { handsBusy = false, paperAllowed = true, inSprint = false } = {}) {
  const onAnswer = vi.fn<(a: CardAnswer) => void>();
  render(
    <StudyDisplayContext.Provider value={{ courseDay: 3, inSprint, taught: TAUGHT_DAY_3, kana: KANA }}>
      <ReviewCard prepared={prepared} onAnswer={onAnswer} handsBusy={handsBusy} paperAllowed={paperAllowed} />
    </StudyDisplayContext.Provider>,
  );
  return onAnswer;
}

const type = (label: RegExp | string, text: string) => {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
};
const choices = () => within(screen.getByRole('group', { name: 'Answer choices' }));

beforeEach(async () => {
  await resetStudyDb();
  audioMock.play.mockClear();
  vi.mocked(recognitionAvailable).mockReturnValue(false);
  vi.mocked(listen).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('typed cards', () => {
  it('show no choice buttons by default, and grade a right typed answer Good', async () => {
    const onAnswer = show(await prep('word', 'w-ike', 'read'));
    expect(screen.queryByRole('group', { name: 'Answer choices' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show options' })).toBeTruthy();
    type('Reading', 'ike');
    fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ grade: Rating.Good, mode: 'typed' }));
  });

  it('"Show options" is a hint: a right pick is mode choice and at most Hard, a wrong one Again', async () => {
    const onAnswer = show(await prep('kanaRule', 'hira-dakuten', 'read'));
    fireEvent.click(screen.getByRole('button', { name: 'Show options' }));
    fireEvent.click(choices().getByRole('button', { name: /かぎ/ }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Hard, mode: 'choice' });

    cleanup();
    const wrong = show(await prep('kanaRule', 'hira-dakuten', 'read'));
    fireEvent.click(screen.getByRole('button', { name: 'Show options' }));
    fireEvent.click(choices().getAllByRole('button').find((b) => !b.textContent?.includes('かぎ'))!);
    expect(wrong).toHaveBeenCalledWith({ grade: Rating.Again, mode: 'choice' });
  });

  it('allows one retry: right on the second try is Hard, wrong twice is Again', async () => {
    const onAnswer = show(await prep('kanaRule', 'hira-dakuten', 'read'));
    type('Reading', 'kagu');
    expect(await screen.findByText('Not quite. One more try.')).toBeTruthy();
    type('Reading', 'kagi');
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Hard, mode: 'typed' });

    cleanup();
    const twice = show(await prep('kanaRule', 'hira-dakuten', 'read'));
    type('Reading', 'kagu');
    type('Reading', 'kago');
    expect(twice).toHaveBeenCalledWith({ grade: Rating.Again, mode: 'typed' });
  });

  it('hands-busy mode shows the options at once and logs choice', async () => {
    const onAnswer = show(await prep('kanaRule', 'hira-dakuten', 'read'), { handsBusy: true });
    expect(screen.queryByLabelText('Reading')).toBeNull();
    fireEvent.click(choices().getByRole('button', { name: /かぎ/ }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Hard, mode: 'choice' });
  });

  it('word read logs both parts of the answer', async () => {
    const onAnswer = show(await prep('word', 'w-ike', 'read'));
    type('Reading', 'ike');
    expect(await screen.findByText('pond')).toBeTruthy();
    expect(audioMock.play).toHaveBeenCalledWith({ ref: 'word:w-ike' }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Again, mode: 'typed', parts: { reading: true, meaning: false }, revealed: true });
  });
});

describe('kana cards and romaji', () => {
  it('a sprint kana-write card shows no romaji anywhere and plays the sound by itself', async () => {
    await db.settings.update('me', { audio: true });
    show(await prep('kana', 'か', 'write', { inSprint: true }), { inSprint: true });
    expect(screen.getByRole('heading', { name: 'Write the hiragana you hear' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bka\b/);
    await waitFor(() => expect(audioMock.play).toHaveBeenCalledWith({ ref: 'kana:か' }, expect.anything()));
    expect(screen.getByRole('button', { name: /Play the sound/ })).toBeTruthy();
  });

  it('takes romaji on a sprint kana-read card, and no romaji at all once the sprint is over', async () => {
    const onAnswer = show(await prep('kana', 'か', 'read', { inSprint: true }), { inSprint: true });
    type('The sound', 'ka');
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'typed' });

    cleanup();
    show(await prep('kana', 'か', 'read'));
    expect(screen.getByText('umbrella')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bka\b|\bkasa\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Show options' }));
    for (const b of choices().getAllByRole('button')) expect(b.textContent).not.toMatch(/[a-z]{2}/);
  });
});

describe('writing cards', () => {
  it('grades a recall written right Good, and offers "I wrote it right" after an Again', async () => {
    const onAnswer = show(await prep('kanji', '水', 'write'));
    expect(screen.getByText(/□/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Write it right' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'written', input: 'finger' });

    cleanup();
    const missed = show(await prep('kanji', '水', 'write'));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave a stroke out' }));
    expect(missed).not.toHaveBeenCalled();
    expect(screen.getByText('1 stroke missing.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote it right' }));
    expect(missed).toHaveBeenCalledWith({ grade: Rating.Hard, mode: 'written', input: 'finger', override: true });
  });

  it('hides "Write on paper" in an anywhere sitting; on paper it self-checks', async () => {
    show(await prep('kanji', '水', 'write'), { paperAllowed: false });
    expect(screen.queryByRole('button', { name: 'Write on paper' })).toBeNull();

    cleanup();
    const onAnswer = show(await prep('kanji', '水', 'write'));
    fireEvent.click(screen.getByRole('button', { name: 'Write on paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'paper', input: 'paper', revealed: true });
  });
});

describe('self-graded and spoken cards', () => {
  it('listen: the audio plays, the text stays hidden until revealed, then Missed / Got it', async () => {
    await db.settings.update('me', { audio: true });
    const onAnswer = show(await prep('core', 'cw-0001', 'listen'));
    await waitFor(() => expect(audioMock.play).toHaveBeenCalledWith({ ref: 'core:cw-0001' }, expect.anything()));
    expect(screen.queryByText('thank you')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the answer' }));
    expect(screen.getByText('thank you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Missed' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Again, mode: 'self', revealed: true });
    expect((screen.getByRole('button', { name: 'Got it' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('produce: with recognition offline only the typed input renders', async () => {
    vi.mocked(recognitionAvailable).mockReturnValue(true);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    show(await prep('core', 'cw-0001', 'produce'));
    expect(screen.queryByRole('button', { name: 'Say it' })).toBeNull();
    expect(screen.getByLabelText('Or type it')).toBeTruthy();
    online.mockRestore();
  });

  it('produce: two failed recognitions offer "I said it", graded at most Hard', async () => {
    vi.mocked(recognitionAvailable).mockReturnValue(true);
    vi.mocked(listen).mockImplementation(() => ({ result: Promise.resolve('なにか'), stop: vi.fn() }));
    const onAnswer = show(await prep('core', 'cw-0001', 'produce'));
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    expect(await screen.findByText(/Didn't catch that/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I said it — check myself' }));
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Hard, mode: 'spoken', revealed: true });
  });

  it('produce: a recognised answer is Good, mode spoken', async () => {
    vi.mocked(recognitionAvailable).mockReturnValue(true);
    vi.mocked(listen).mockImplementation(() => ({ result: Promise.resolve('ありがとう'), stop: vi.fn() }));
    const onAnswer = show(await prep('core', 'cw-0001', 'produce'));
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'spoken' }));
  });
});

describe('KanaInput', () => {
  function Field() {
    const [value, setValue] = useState('');
    return <KanaInput value={value} onChange={setValue} label="Answer" />;
  }

  it('turns romaji into kana as you type, outside composition', () => {
    render(<Field />);
    const input = screen.getByLabelText('Answer') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ki' } });
    expect(input.value).toBe('き');
    fireEvent.change(input, { target: { value: 'きtte' } });
    expect(input.value).toBe('きって');
  });

  it('leaves the text alone while an IME composes, and keeps the composed kana', () => {
    render(<Field />);
    const input = screen.getByLabelText('Answer') as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'かn' }, nativeEvent: { isComposing: true } });
    expect(input.value).toBe('かn');
    fireEvent.change(input, { target: { value: 'かんじ' } });
    expect(input.value).toBe('かんじ');
    fireEvent.compositionEnd(input);
    expect(input.value).toBe('かんじ');
  });

  it('turns off autocorrect, autocapitalize, autocomplete and spellcheck', () => {
    render(<Field />);
    const input = screen.getByLabelText('Answer');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('lang')).toBe('ja');
  });
});

describe('KanaText', () => {
  it('on course day 3 shows romaji over り and が only in ありがとう', () => {
    const { container } = render(
      <StudyDisplayContext.Provider value={{ courseDay: 3, inSprint: true, taught: TAUGHT_DAY_3, kana: KANA }}>
        <KanaText text="ありがとう" />
      </StudyDisplayContext.Provider>,
    );
    const ruby = [...container.querySelectorAll('ruby')].map((r) => [r.firstChild?.textContent, r.querySelector('rt')?.textContent]);
    expect(ruby).toEqual([['り', 'ri'], ['が', 'ga']]);
    expect(container.textContent).toBe('ありriがgaとう');
  });

  it('shows no romaji once the sprint is over', () => {
    const { container } = render(
      <StudyDisplayContext.Provider value={{ courseDay: 30, inSprint: false, taught: TAUGHT_DAY_3, kana: KANA }}>
        <KanaText text="ありがとう" />
      </StudyDisplayContext.Provider>,
    );
    expect(container.querySelector('ruby')).toBeNull();
    expect(container.textContent).toBe('ありがとう');
  });
});

it('a self-graded card disables both buttons after the first tap', async () => {
  const onAnswer = show(await prep('kanji', '曜', 'meaning'));
  fireEvent.click(screen.getByRole('button', { name: 'Show the meaning' }));
  const got = screen.getByRole('button', { name: 'Got it' });
  await act(async () => {
    fireEvent.click(got);
    fireEvent.click(got);
  });
  expect(onAnswer).toHaveBeenCalledTimes(1);
});
