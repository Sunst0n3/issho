import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db, updateSettings } from '../../lib/db.ts';
import { introduceItem, markKnownMany } from '../../srs/items.ts';
import { pickTarget } from './readingQuestion.ts';
import { ReadingDrill } from './ReadingDrill.tsx';
import { unsaveSentence } from './sentences.ts';
import { CURRICULUM, resetStudyDb, SENTENCES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);

const choices = () => within(screen.getByRole('group', { name: 'Answer choices' }));
const shown = () => JSON.parse(localStorage.getItem('issho.srs.sentencesShown') ?? '{}') as Record<string, string>;

beforeEach(async () => {
  await resetStudyDb();
});

/** Sentences can be saved from phase 3: learn every fixture unit but 水, which the tests then learn last. */
async function reachPhase3() {
  await updateSettings({ knowsHiragana: true, knowsKatakana: true });
  await markKnownMany(CURRICULUM.units.filter((u) => u.char !== '水').map((u) => ({ kind: u.type, key: u.char })));
}

afterEach(() => {
  cleanup();
});

describe('pickTarget', () => {
  const known = new Set(['日', '水', '木']);

  it('prefers the word with the most recently learned kanji, else the first word with a reading', () => {
    const jp = '{日|ひ}と{水|みず}と{木|き}';
    expect(pickTarget(jp, ['木', '水'], known)).toBe(4);
    expect(pickTarget(jp, ['水', '木'], known)).toBe(2);
    expect(pickTarget(jp, [], known)).toBe(0);
    expect(pickTarget('あおい。', ['水'], known)).toBe(-1);
  });

  it('never asks about a word with a kanji the learner has not met (the +1 keeps its furigana)', () => {
    expect(pickTarget('{火|ひ}と{水|みず}', [], known)).toBe(2);
    expect(pickTarget('{火曜日|かようび}と{水|みず}', [], known)).toBe(2);
    expect(pickTarget('いい{火|ひ}でした。', [], known)).toBe(-1);
    expect(pickTarget('いい{日|ひ}でした。', [], new Set())).toBe(-1);
  });
});

describe('ReadingDrill', () => {
  it('asks for the reading of the underlined word, saves the sentence, then asks what a kana sentence means', async () => {
    await reachPhase3();
    await introduceItem('kanji', '水');
    const onDone = vi.fn();
    const sentences = [SENTENCES[0], SENTENCES[1]];
    render(<ReadingDrill sentences={sentences} onDone={onDone} />);

    expect(await screen.findByRole('heading', { name: 'How do you read the underlined word?' })).toBeTruthy();
    expect(document.querySelector('.st-target')?.textContent).toBe('水');
    // The reading of the target stays hidden until answered.
    expect(document.querySelector('.st-target rt')).toBeNull();
    expect(screen.queryByText('I drink water.')).toBeNull();

    fireEvent.click(choices().getByRole('button', { name: 'みず' }));
    expect(screen.getByText('Correct')).toBeTruthy();
    expect(screen.getByText('I drink water.')).toBeTruthy();
    expect(document.querySelector('.st-target rt')?.textContent).toBe('みず');

    fireEvent.click(await screen.findByRole('button', { name: 'Save sentence' }));
    expect(await screen.findByRole('button', { name: 'Saved for review' })).toBeTruthy();
    expect((await db.savedSentences.get('s-mizu'))?.en).toBe('I drink water.');
    const readCard = await db.cards.get(cardId('sentence:s-mizu', 'read'));
    expect(readCard?.suspended).toBeFalsy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'What does this mean?' })).toBeTruthy();
    const options = choices().getAllByRole('button');
    expect(options).toHaveLength(4);
    expect(options.map((b) => b.textContent?.replace(/^\d/, ''))).toContain('Blue.');
    fireEvent.click(options.find((b) => !b.textContent?.endsWith('Blue.'))!);
    expect(screen.getByText(/Not quite/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(Object.keys(shown()).sort()).toEqual(['s-aoi', 's-mizu']);
  });

  it('prefers a recently learned kanji for the question', async () => {
    await introduceItem('kanji', '水');
    render(<ReadingDrill sentences={[{ id: 'x', jp: '{日|ひ}と{水|みず}', en: 'Sun and water.' }]} onDone={() => {}} />);
    await screen.findByRole('heading', { name: 'How do you read the underlined word?' });
    expect(document.querySelector('.st-target')?.textContent).toBe('水');
  });

  it('asks what a sentence means when its only kanji is new, and shows the furigana of that kanji', async () => {
    render(<ReadingDrill sentences={[SENTENCES[0]]} onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'What does this mean?' })).toBeTruthy();
    expect(document.querySelector('.st-target')).toBeNull();
    // 水 has not been learned yet, so its reading shows (furigana 'unknown' is the default).
    expect(document.querySelector('.st-sentence rt')?.textContent).toBe('みず');
    expect(choices().getAllByRole('button').map((b) => b.textContent?.replace(/^\d/, ''))).toContain('I drink water.');
  });

  it('offers saving a sentence only from phase 3', async () => {
    await updateSettings({ knowsHiragana: true, knowsKatakana: true });
    await introduceItem('kanji', '水');
    const readOnce = async () => {
      render(<ReadingDrill sentences={[SENTENCES[0]]} onDone={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'みず' }));
      // Let the phase lookup settle before checking what is offered.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(screen.getByText('I drink water.')).toBeTruthy();
      return screen.queryByRole('button', { name: 'Save sentence' });
    };

    expect(await readOnce()).toBeNull();
    cleanup();
    await reachPhase3();
    expect(await readOnce()).toBeTruthy();
  });

  it('removing a saved sentence stops its reviews, and saving it again brings them back', async () => {
    await reachPhase3();
    await introduceItem('kanji', '水');
    render(<ReadingDrill sentences={[SENTENCES[0]]} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'みず' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save sentence' }));
    await screen.findByRole('button', { name: 'Saved for review' });

    await unsaveSentence('s-mizu');
    expect(await db.savedSentences.get('s-mizu')).toBeUndefined();
    expect((await db.cards.get(cardId('sentence:s-mizu', 'read')))?.suspended).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Save sentence' }));
    await screen.findByRole('button', { name: 'Saved for review' });
    expect((await db.cards.get(cardId('sentence:s-mizu', 'read')))?.suspended).toBe(false);
  });
});
