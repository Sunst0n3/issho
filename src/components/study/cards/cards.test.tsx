import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, itemId } from '../../../lib/db.ts';
import type { CardRecord, CardType, ItemKind } from '../../../lib/types.ts';
import { newCardRecord } from '../../../srs/scheduler.ts';
import { GRAMMAR, KANA, KANJI, RADICALS, resetStudyDb, SURVIVAL, WORDS } from '../test-utils.tsx';
import { GrammarDrillCard } from './GrammarDrillCard.tsx';
import { KanaReadCard } from './KanaReadCard.tsx';
import { KanaWriteCard } from './KanaWriteCard.tsx';
import { KanjiMeaningCard } from './KanjiMeaningCard.tsx';
import { KanjiReadingCard } from './KanjiReadingCard.tsx';
import { KanjiWriteCard } from './KanjiWriteCard.tsx';
import { RadicalMeaningCard } from './RadicalMeaningCard.tsx';
import { SentenceReadCard } from './SentenceReadCard.tsx';
import type { CardAnswer } from './types.ts';
import { VocabMeaningCard } from './VocabMeaningCard.tsx';
import { VocabRecallCard } from './VocabRecallCard.tsx';
import { WordMeaningCard } from './WordMeaningCard.tsx';
import { WordReadingCard } from './WordReadingCard.tsx';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../writing/WritingPad.tsx', async () => (await import('../test-utils.tsx')).writingPadMock);

const card = (kind: ItemKind, key: string, type: CardType): CardRecord => newCardRecord(itemId(kind, key), kind, type);
const choice = (name: string | RegExp) => within(screen.getByRole('group', { name: 'Answer choices' })).getByRole('button', { name });
const answer = (onAnswer: ReturnType<typeof vi.fn>) => onAnswer.mock.calls[0][0] as CardAnswer;

const shi = KANA.find((k) => k.char === 'し')!;
const mizu = WORDS.find((w) => w.id === 'w-mizu')!;
const suiyoubi = WORDS.find((w) => w.id === 'w-sui')!;

beforeEach(async () => {
  await resetStudyDb();
});

afterEach(() => {
  cleanup();
});

describe('kana cards', () => {
  it('read: a right choice is Good', () => {
    const onAnswer = vi.fn();
    render(<KanaReadCard prepared={{ view: 'kana-read', card: card('kana', 'し', 'read'), kana: shi, options: ['a', 'shi', 'ka', 'mi'] }} onAnswer={onAnswer} />);
    expect(screen.getByRole('heading', { name: 'What sound is this hiragana?' })).toBeTruthy();
    fireEvent.click(choice('shi'));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, mode: 'choice', correct: true, feedback: { expected: 'shi', speak: 'し' } });
    expect(choice('shi, correct answer').className).toContain('correct');
  });

  it('read: number keys pick a choice, and a wrong one is Again', () => {
    const onAnswer = vi.fn();
    render(<KanaReadCard prepared={{ view: 'kana-read', card: card('kana', 'し', 'read'), kana: shi, options: ['a', 'shi', 'ka', 'mi'] }} onAnswer={onAnswer} />);
    fireEvent.keyDown(window, { key: '3' });
    expect(answer(onAnswer)).toMatchObject({ grade: 1, correct: false });
    expect(choice('ka, your answer').className).toContain('wrong');
    fireEvent.keyDown(window, { key: '2' });
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('read: number keys do nothing while a dialog is over the card', () => {
    const onAnswer = vi.fn();
    render(
      <>
        <KanaReadCard prepared={{ view: 'kana-read', card: card('kana', 'し', 'read'), kana: shi, options: ['a', 'shi', 'ka', 'mi'] }} onAnswer={onAnswer} />
        <div role="alertdialog" aria-modal="true" aria-label="Stop for now?" />
      </>,
    );
    fireEvent.keyDown(window, { key: '2' });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('read: typed romaji accepts alternatives; a second try is Hard', () => {
    const onAnswer = vi.fn();
    render(<KanaReadCard prepared={{ view: 'kana-read', card: card('kana', 'し', 'read'), kana: shi, options: ['a', 'shi', 'ka', 'mi'] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type it instead' }));
    const input = screen.getByLabelText('Romaji');
    fireEvent.change(input, { target: { value: 'su' } });
    fireEvent.submit(input);
    expect(screen.getByText('Not quite. One more try.')).toBeTruthy();
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'si' } });
    fireEvent.submit(input);
    expect(answer(onAnswer)).toMatchObject({ grade: 2, mode: 'typed', correct: true });
    // The choice remembers typing for next time.
    expect(localStorage.getItem('issho.study.typed')).toContain('"kana-read":true');
  });

  it('write: a clean character is Good; giving up is Again', async () => {
    const onAnswer = vi.fn();
    const kana = KANA.find((k) => k.char === 'あ')!;
    const prepared = { view: 'kana-write' as const, card: card('kana', 'あ', 'write'), kana };
    const view = render(<KanaWriteCard prepared={prepared} onAnswer={onAnswer} />);
    expect(screen.getByRole('heading', { name: 'Write the hiragana for' })).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish writing' }));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, mode: 'written', correct: true, feedback: { title: 'Well written', expected: 'あ' } });

    view.unmount();
    onAnswer.mockClear();
    render(<KanaWriteCard prepared={prepared} onAnswer={onAnswer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Give up' }));
    expect(answer(onAnswer)).toMatchObject({ grade: 1, correct: false });
  });

  it('write: names the row when the romaji fits two kana', async () => {
    const di = { char: 'ぢ', script: 'hiragana' as const, romaji: 'ji', group: 'da', kind: 'dakuten' as const, order: 56 };
    render(<KanaWriteCard prepared={{ view: 'kana-write', card: card('kana', 'ぢ', 'write'), kana: di, row: 'だ' }} onAnswer={vi.fn()} />);
    expect(screen.getByText('ji')).toBeTruthy();
    expect(document.querySelector('.st-write-target')?.textContent).toBe('ji(だ row)');
  });

  it('write: on paper, the learner grades themselves', async () => {
    const onAnswer = vi.fn();
    const kana = KANA.find((k) => k.char === 'あ')!;
    render(<KanaWriteCard prepared={{ view: 'kana-write', card: card('kana', 'あ', 'write'), kana }} onAnswer={onAnswer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Write on paper instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show the answer' }));
    expect(screen.getByRole('img', { name: /Stroke order animation for あ/ })).toBeTruthy();
    const grades = screen.getByRole('group', { name: 'How did your writing compare?' });
    expect(within(grades).getAllByRole('button').map((b) => b.textContent?.replace(/[\d.]+(m|h|d|mo|y)$/, ''))).toEqual(['Again', 'Hard', 'Good', 'Easy']);
    fireEvent.click(within(grades).getByRole('button', { name: /Easy/ }));
    expect(answer(onAnswer)).toEqual({ grade: 4, mode: 'self', correct: true });
  });
});

describe('radical and kanji cards', () => {
  it('radical meaning: a wrong pick shows what it is', () => {
    const onAnswer = vi.fn();
    render(<RadicalMeaningCard prepared={{ view: 'radical-meaning', card: card('radical', '氵', 'meaning'), radical: RADICALS[0], options: ['hand', 'water', 'roof', 'mouth'] }} onAnswer={onAnswer} />);
    fireEvent.click(choice('hand'));
    expect(answer(onAnswer)).toMatchObject({ grade: 1, correct: false, feedback: { expected: 'water', note: 'water (side), a form of 水' } });
  });

  it('kanji meaning: typed answers forgive a small typo but not another option', () => {
    const onAnswer = vi.fn();
    const prepared = { view: 'kanji-meaning' as const, card: card('kanji', '水', 'meaning'), kanji: KANJI['水'], options: ['water', 'waiter', 'fire', 'tree'], notAccepted: ['waiter', 'fire', 'tree'] };
    const view = render(<KanjiMeaningCard prepared={prepared} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type it instead' }));
    const input = screen.getByLabelText('Meaning');
    fireEvent.change(input, { target: { value: 'Watr' } });
    fireEvent.submit(input);
    expect(answer(onAnswer)).toMatchObject({ grade: 3, mode: 'typed', correct: true });

    view.unmount();
    onAnswer.mockClear();
    render(<KanjiMeaningCard prepared={prepared} onAnswer={onAnswer} />);
    const again = screen.getByLabelText('Meaning');
    for (let i = 0; i < 2; i++) {
      fireEvent.change(again, { target: { value: 'waiter' } });
      fireEvent.submit(again);
    }
    expect(answer(onAnswer)).toMatchObject({ grade: 1, correct: false });
  });

  it('kanji reading: the kanji is underlined in its word and the feedback breaks the word down', () => {
    const onAnswer = vi.fn();
    render(<KanjiReadingCard onAnswer={onAnswer} prepared={{
      view: 'kanji-reading', card: card('kanji', '水', 'reading'), kanji: KANJI['水'], word: suiyoubi,
      answer: 'すいようび', options: ['すいようび', 'もくようび', 'かようび', 'にちようび'],
      breakdown: [{ char: '水', meaning: 'water' }, { char: '曜', meaning: 'weekday' }, { char: '日', meaning: 'day' }],
    }} />);
    expect(document.querySelector('.st-target')?.textContent).toBe('水');
    fireEvent.click(choice('すいようび'));
    const a = answer(onAnswer);
    expect(a).toMatchObject({ grade: 3, feedback: { expected: 'すいようび', note: 'Wednesday', speak: 'すいようび' } });
    expect(a.feedback?.breakdown).toHaveLength(3);
  });

  it('kanji write: shows the meaning and a reading, then checks the writing', async () => {
    const onAnswer = vi.fn();
    render(<KanjiWriteCard prepared={{ view: 'kanji-write', card: card('kanji', '水', 'write'), kanji: KANJI['水'], reading: 'みず' }} onAnswer={onAnswer} />);
    expect(screen.getByRole('heading', { name: 'Write the kanji for' })).toBeTruthy();
    expect(screen.getByText('みず')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Miss a stroke' }));
    expect(screen.getByText('Check the direction this stroke travels.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish writing' }));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, mode: 'written', feedback: { expected: '水', speak: 'みず' } });
  });
});

describe('word, vocab and grammar cards', () => {
  it('word reading: typed romaji turns into kana as you type', () => {
    const onAnswer = vi.fn();
    render(<WordReadingCard prepared={{ view: 'word-reading', card: card('word', 'w-mizu', 'reading'), word: mizu, options: ['みず', 'ひ', 'き', 'かね'], breakdown: [] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type it instead' }));
    const input = screen.getByLabelText('Reading');
    fireEvent.change(input, { target: { value: 'miz' } });
    expect(screen.getByText('みz')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'mizu' } });
    expect(screen.getByText('みず')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, mode: 'typed', correct: true });
  });

  it('word reading: a long-vowel mark may be typed as its vowel', () => {
    const onAnswer = vi.fn();
    const biidama = { id: 'w-biidama', written: 'ビー玉', kana: 'ビーだま', meanings: ['marble'], pos: ['n'], freqRank: 20, kanji: ['玉'] };
    localStorage.setItem('issho.study.typed', JSON.stringify({ 'word-reading': true }));
    render(<WordReadingCard prepared={{ view: 'word-reading', card: card('word', 'w-biidama', 'reading'), word: biidama, options: [], breakdown: [] }} onAnswer={onAnswer} />);
    const input = screen.getByLabelText('Reading');
    fireEvent.change(input, { target: { value: 'bidama' } });
    fireEvent.submit(input);
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'biidama' } });
    fireEvent.submit(input);
    expect(answer(onAnswer)).toMatchObject({ grade: 2, mode: 'typed', correct: true });
  });

  it("word reading: \"I don't know\" is Again", () => {
    const onAnswer = vi.fn();
    localStorage.setItem('issho.study.typed', JSON.stringify({ 'word-reading': true }));
    render(<WordReadingCard prepared={{ view: 'word-reading', card: card('word', 'w-mizu', 'reading'), word: mizu, options: ['みず', 'ひ', 'き', 'かね'], breakdown: [] }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: "I don't know" }));
    expect(answer(onAnswer)).toMatchObject({ grade: 1, mode: 'typed', correct: false });
  });

  it('word meaning: choice of English meanings', () => {
    const onAnswer = vi.fn();
    render(<WordMeaningCard prepared={{ view: 'word-meaning', card: card('word', 'w-sui', 'meaning'), word: suiyoubi, options: ['Wednesday', 'fire', 'money', 'person'], breakdown: [] }} onAnswer={onAnswer} />);
    expect(screen.getByText('水曜日')).toBeTruthy();
    fireEvent.click(choice('Wednesday'));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, mode: 'choice', feedback: { expected: 'Wednesday', speak: 'すいようび' } });
  });

  it('vocab meaning and recall', () => {
    const onAnswer = vi.fn();
    const ie = SURVIVAL[1];
    const view = render(<VocabMeaningCard prepared={{ view: 'vocab-meaning', card: card('vocab', ie.id, 'meaning'), vocab: ie, options: ['love', 'house', 'above', 'face'] }} onAnswer={onAnswer} />);
    fireEvent.click(choice('house'));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, feedback: { note: 'A home or a building.' } });
    view.unmount();

    onAnswer.mockClear();
    render(<VocabRecallCard prepared={{ view: 'vocab-recall', card: card('vocab', ie.id, 'recall'), vocab: ie, options: ['あい', 'いえ', 'うえ', 'かお'] }} onAnswer={onAnswer} />);
    expect(screen.getByText('house')).toBeTruthy();
    fireEvent.click(choice('うえ'));
    expect(answer(onAnswer)).toMatchObject({ grade: 1, correct: false, feedback: { expected: 'いえ', expectedLang: 'ja' } });
  });

  it('grammar drill: the English shows before answering and the gap fills after', () => {
    const onAnswer = vi.fn();
    const drill = GRAMMAR[0].drills[0];
    render(<GrammarDrillCard prepared={{ view: 'grammar-drill', card: card('grammar', 'wa-desu', 'drill'), point: GRAMMAR[0], drill, options: ['か', 'を', 'は'] }} onAnswer={onAnswer} />);
    expect(screen.getByText('I am a student.')).toBeTruthy();
    expect(document.querySelector('.st-gap.filled')).toBeNull();
    fireEvent.click(choice('は'));
    expect(answer(onAnswer)).toMatchObject({ grade: 3, feedback: { expected: 'は', speak: 'わたしはがくせいです。' } });
    expect(document.querySelector('.st-gap.filled')?.textContent).toBe('は');
  });

  it('sentence read: reveal, then grade yourself', async () => {
    const onAnswer = vi.fn();
    const c = card('sentence', 's-mizu', 'read');
    expect(c.id).toBe(cardId('sentence:s-mizu', 'read'));
    render(<SentenceReadCard prepared={{ view: 'sentence-read', card: c, sentence: { id: 's-mizu', jp: '{水|みず}をのむ。', en: 'I drink water.' } }} onAnswer={onAnswer} />);
    expect(screen.queryByText('I drink water.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByText('I drink water.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Did you understand it?' })).getByRole('button', { name: /Good/ }));
    expect(answer(onAnswer)).toEqual({ grade: 3, mode: 'self', correct: true });
  });
});
