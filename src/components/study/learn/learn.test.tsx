import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanaEntry } from '../../../lib/types.ts';
import { KANA, KANA_EXAMPLES, KANJI, resetStudyDb, WORDS } from '../test-utils.tsx';
import { kanaExample, learnedLabels, usesKana } from './data.ts';
import { KanjiLesson, MemoryHook, MNEMONIC_MAX } from './KanjiLesson.tsx';
import { VocabLesson } from './VocabLesson.tsx';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../writing/WritingPad.tsx', async () => (await import('../test-utils.tsx')).writingPadMock);

const kana = (char: string, romaji: string, order: number): KanaEntry =>
  ({ char, script: 'hiragana', romaji, group: romaji, kind: 'basic', order });
const COURSE = [...KANA, kana('こ', 'ko', 20), kana('ん', 'n', 21), kana('に', 'ni', 22), kana('ち', 'chi', 23), kana('は', 'ha', 24)];

beforeEach(async () => {
  await resetStudyDb();
});

afterEach(() => {
  cleanup();
});

describe('kana learn card example', () => {
  it('uses the hand-picked example word, with its usual spelling', async () => {
    expect(await kanaExample(KANA.find((k) => k.char === 'い')!)).toEqual(KANA_EXAMPLES['い']);
  });

  it('falls back to a word search, never a word with the kana only inside a yōon', async () => {
    expect(usesKana('きゅう', 'き')).toBe(false);
    expect(usesKana('きく', 'き')).toBe(true);
    expect(usesKana('ファン', 'フ')).toBe(false);
    expect(usesKana('きゃく', 'きゃ')).toBe(true);
    // あ has no hand-picked example in the test data: the survival word あい.
    expect(await kanaExample(KANA.find((k) => k.char === 'あ')!)).toEqual({ kana: 'あい', en: 'love' });
  });

  it('falls back when the examples file is missing (an older offline copy)', async () => {
    const data = await import('../../../lib/data.ts');
    const spy = vi.spyOn(data, 'loadKanaExamples').mockRejectedValueOnce(new Error('404'));
    expect(await kanaExample(KANA.find((k) => k.char === 'い')!)).toEqual({ kana: 'いえ', en: 'house' });
    spy.mockRestore();
  });
});

describe('VocabLesson', () => {
  it('writes the particle は as "wa" in the romaji, and marks the Japanese in the note', () => {
    render(<VocabLesson vocab={{ id: 'sw-konnichiwa', kana: 'こんにちは', en: 'hello', note: 'The final は is read "wa".' }} kana={COURSE} onNext={() => {}} />);
    expect(screen.getByText('konnichiwa')).toBeTruthy();
    expect(document.querySelector('.st-note [lang="ja"]')?.textContent).toBe('は');
  });
});

describe('KanjiLesson', () => {
  it('shows romaji for its words when romaji is on, like the readings', async () => {
    render(<KanjiLesson kanji={KANJI['水']} words={[WORDS[0]]} kana={KANA} onHookChange={() => {}} onPractice={() => {}} />);
    expect(await screen.findByText('mizu', { selector: '.st-word-kana .st-romaji' })).toBeTruthy();
  });

  it('allows the same memory-hook length as the kanji page (200 characters)', () => {
    expect(MNEMONIC_MAX).toBe(200);
    render(<MemoryHook text="A splash." onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory hook' }));
    expect(screen.getByLabelText('Your memory hook').getAttribute('maxlength')).toBe('200');
  });

  it('moves focus into the hook editor and back to Edit when it closes', () => {
    render(<MemoryHook text="A splash." onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory hook' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Your memory hook'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit memory hook' }));
  });
});

describe('learnedLabels', () => {
  it('labels items by id for the summary, leaving out words', async () => {
    expect(await learnedLabels(['kana:あ', 'kanji:水', 'word:w-mizu', 'vocab:sw-ie', 'grammar:wa-desu', 'kanji:龍'])).toEqual([
      { itemId: 'kana:あ', text: 'あ', lang: 'ja', meaning: 'a' },
      { itemId: 'kanji:水', text: '水', lang: 'ja', meaning: 'water' },
      { itemId: 'vocab:sw-ie', text: 'いえ', lang: 'ja', meaning: 'house' },
      { itemId: 'grammar:wa-desu', text: '〜は〜です', lang: 'ja', meaning: 'grammar' },
    ]);
  });
});
