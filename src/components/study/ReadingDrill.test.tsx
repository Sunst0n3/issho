import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../lib/db.ts';
import { introduceItem } from '../../srs/items.ts';
import { glossQuestion, shortGloss } from './readingQuestion.ts';
import { ReadingDrill, splitTarget } from './ReadingDrill.tsx';
import { blankFor, saveSentence } from './sentences.ts';
import { audioMock, resetStudyDb, SENTENCES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);
vi.mock('../../speech/recorder.ts', () => ({ micAvailable: () => false }));

const DAY = 86_400_000;

beforeEach(async () => {
  await resetStudyDb();
  audioMock.play.mockClear();
  await introduceItem('word', 'w-mizu', new Date(Date.now() - 2 * DAY));
});

afterEach(() => {
  cleanup();
});

function drill(sentences = [{ id: 's-mizu', target: 'word:w-mizu' as const }]) {
  const onDone = vi.fn();
  render(<ReadingDrill sentences={sentences} onDone={onDone} doneLabel="Finish" />);
  return onDone;
}

describe('ReadingDrill', () => {
  it('reads aloud first, then listens with the phrase pitch, then the gloss is guessed before the translation shows', async () => {
    drill();
    expect(await screen.findByRole('heading', { name: 'Read it aloud first' })).toBeTruthy();
    expect(document.querySelector('u.st-target')?.textContent).toMatch(/^水/);
    expect(screen.queryByText('It is water.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(audioMock.play).toHaveBeenCalledWith({ ref: 'sentence:s-mizu' }, expect.anything());
    const pitch = await screen.findByRole('img', { name: /Sentence pitch/ });
    // Labelled in the sentence's spelling, not the engine's katakana (ミズデス).
    expect([...pitch.querySelectorAll('.st-pitch-mora')].map((t) => t.textContent)).toEqual(['み', 'ず', 'で', 'す']);

    await waitFor(() => expect((screen.getByRole('button', { name: 'What does it mean?' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'What does it mean?' }));
    const grid = await screen.findByRole('group', { name: 'Answer choices' });
    expect(screen.queryByText('It is water.')).toBeNull();
    expect(within(grid).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(within(grid).getByRole('button', { name: /water/ }));
    expect(await screen.findByText('It is water.')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
  });

  it('can save the sentence as a cloze card from the first day, blanking the target', async () => {
    drill();
    fireEvent.click(await screen.findByRole('button', { name: 'Listen' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'What does it mean?' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'What does it mean?' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Answer choices' })).getAllByRole('button')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Save as a card' }));
    await waitFor(async () => expect(await db.cards.get(cardId('sentence:s-mizu', 'cloze'))).toBeTruthy());
    expect(await db.savedSentences.get('s-mizu')).toMatchObject({ source: 'reading', blank: { surface: '水', reading: 'みず', ref: 'word:w-mizu' } });
    expect(await screen.findByRole('button', { name: 'Saved as a card' })).toBeTruthy();
  });

  it('logs the sentence’s words as encounters and rests the sentence after it', async () => {
    const onDone = drill();
    fireEvent.click(await screen.findByRole('button', { name: 'Listen' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'What does it mean?' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'What does it mean?' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Answer choices' })).getAllByRole('button')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await db.shownSentences.get('s-mizu')).toBeTruthy());
    await waitFor(async () => expect((await db.encounters.toArray()).map((e) => [e.itemId, e.source])).toEqual([['word:w-mizu', 'sentence']]));
  });

  it('keeps the target word’s reading, so a recent word with an unknown kanji can be read aloud (V044)', async () => {
    drill();
    await screen.findByRole('heading', { name: 'Read it aloud first' });
    const target = document.querySelector('u.st-target')!;
    expect(target.querySelector('ruby')?.firstChild?.textContent).toBe('水');
    expect(target.querySelector('rt')?.textContent).toBe('みず');
  });

  it('moves on when the planned sentences are not on this phone', async () => {
    const onDone = drill([{ id: 'nope', target: 'word:w-mizu' }]);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

describe('gloss and saving helpers', () => {
  it('offers the target’s gloss and two others, all different', async () => {
    const known = { isKnown: () => true, introducedDay: () => '2026-10-01' };
    const q = await glossQuestion('core:cw-0002', '食べる', known, () => 0.3);
    expect(q?.answer).toBe('to eat');
    expect(q?.options).toHaveLength(3);
    expect(new Set(q?.options).size).toBe(3);
    expect(shortGloss('healthy; well')).toBe('healthy');
  });

  it('splits a sentence around its target, every reading kept', () => {
    expect(splitTarget('お{父|とう}さんによろしく。', 'お父さん')).toEqual({ before: '', target: 'お{父|とう}さん', after: 'によろしく。' });
    expect(splitTarget('{日本|にほん}の{本|ほん}です。', '本', 3)).toEqual({ before: '{日本|にほん}の', target: '{本|ほん}', after: 'です。' });
    // A reading the word's edge cuts through can't be split: it is dropped there.
    expect(splitTarget('{今日|きょう}は', '今')).toEqual({ before: '', target: '今', after: '日は' });
    expect(splitTarget('{水|みず}です。', '木')).toBeNull();
  });

  it('blanks the target token and saves once', async () => {
    expect(blankFor(SENTENCES[1], 'word:w-hon')).toEqual({ surface: '本', reading: 'ほん', ref: 'word:w-hon' });
    expect(blankFor(SENTENCES[1], 'core:cw-0001')).toBeNull();
    expect(await saveSentence(SENTENCES[0], 'word:w-mizu')).toBe(true);
    expect(await saveSentence(SENTENCES[0], 'word:w-mizu')).toBe(true);
    expect(await db.savedSentences.count()).toBe(1);
  });
});
