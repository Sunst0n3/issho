import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createEmptyCard, Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId } from '../../../lib/db.ts';
import type { CardRecord, CardType } from '../../../lib/types.ts';
import { seededRandom } from '../../../srs/random.ts';
import { audioMock, GRAMMAR, resetStudyDb } from '../test-utils.tsx';
import { db } from '../../../lib/db.ts';
import { tilesMatch, typedBuildMatches } from './GrammarBuildCard.tsx';
import { prepareCard, TYPED_BUILD_FROM } from './prepare.ts';
import { ReviewCard } from './ReviewCard.tsx';
import type { CardAnswer, PreparedCard } from './types.ts';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../speech/audio.ts', async () => (await import('../test-utils.tsx')).audioMock);

const known = { isKnown: () => true, introducedDay: () => '2026-10-01' };
const POINT = GRAMMAR[0];

async function prep(type: CardType, { reps = 0, grammarIntroduced = 5 } = {}): Promise<PreparedCard> {
  const itemId = `grammar:${POINT.id}`;
  const card: CardRecord = { ...createEmptyCard(new Date()), reps, id: cardId(itemId, type), itemId, kind: 'grammar', type };
  const p = await prepareCard(card, { courseDay: 30, inSprint: false, taught: new Set(), grammarIntroduced, handsBusy: false, known, random: seededRandom(5) });
  if (!p) throw new Error('missing');
  return p;
}

function show(prepared: PreparedCard) {
  const onAnswer = vi.fn<(a: CardAnswer) => void>();
  render(<ReviewCard prepared={prepared} onAnswer={onAnswer} />);
  return onAnswer;
}

beforeEach(async () => {
  await resetStudyDb({ audio: true });
  audioMock.play.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('grammar comprehend card', () => {
  it('rotates through the examples after the lesson’s three, with audio, and self-grades', async () => {
    const seen = [];
    for (let reps = 0; reps < 4; reps++) {
      const p = await prep('comprehend', { reps });
      if (p.view !== 'grammar-comprehend') throw new Error(p.view);
      seen.push(p.exampleIndex);
    }
    expect(seen).toEqual([3, 4, 5, 6]);

    const onAnswer = show(await prep('comprehend', { reps: 1 }));
    expect(screen.getByText(POINT.examples[4].jp)).toBeTruthy();
    expect(screen.queryByText(POINT.examples[4].en)).toBeNull();
    await waitFor(() => expect(audioMock.play).toHaveBeenCalledWith({ ref: 'grammar:wa-desu#ex4' }, expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Show the meaning' }));
    expect(screen.getByText(POINT.examples[4].en)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'self', revealed: true });
  });
});

describe('grammar build card', () => {
  const tray = () => within(screen.getByRole('group', { name: 'Pieces' }));
  const tapInOrder = (tiles: readonly string[]) => {
    for (const piece of tiles) fireEvent.click(tray().getAllByRole('button', { name: piece }).find((b) => !(b as HTMLButtonElement).disabled)!);
  };

  it('uses tiles while fewer than 60 points are introduced: right first time is Good', async () => {
    const p = await prep('build');
    expect(p).toMatchObject({ view: 'grammar-build', tiles: true });
    const onAnswer = show(p);
    expect(screen.getByText(POINT.buildItems[1].en)).toBeTruthy();
    expect(screen.queryByLabelText('Type the sentence')).toBeNull();
    tapInOrder(POINT.buildItems[1].tiles);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'typed' });
  });

  it('counts a wrong tile order as one retry (then Hard), and a second wrong order as Again', async () => {
    const onAnswer = show(await prep('build', { reps: 1 }));
    const tiles = POINT.buildItems[2].tiles;
    const wrong = [tiles[2], tiles[1], tiles[0], tiles[3]];
    tapInOrder(wrong);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Not quite. One more try.')).toBeTruthy();
    tapInOrder(tiles);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Hard, mode: 'typed' });

    cleanup();
    const twice = show(await prep('build', { reps: 1 }));
    tapInOrder(wrong);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    tapInOrder(wrong);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(twice).toHaveBeenCalledWith({ grade: Rating.Again, mode: 'typed' });
  });

  it('is typed once 60 points are introduced, accepting the は/わ particle spellings', async () => {
    const p = await prep('build', { reps: 2, grammarIntroduced: TYPED_BUILD_FROM });
    expect(p).toMatchObject({ tiles: false, itemIndex: 0 });
    const onAnswer = show(p);
    expect(screen.queryByRole('group', { name: 'Pieces' })).toBeNull();
    const input = screen.getByLabelText('Type the sentence');
    fireEvent.change(input, { target: { value: 'watashiwagakuseidesu' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'typed' });
  });

  it('accepts an authored alternative as a tile order', () => {
    expect(tilesMatch(['これは', 'ほん', 'です'], POINT.buildItems[1])).toBe(true);
    expect(tilesMatch(['です', 'ほん'], POINT.buildItems[1])).toBe(false);
  });
});

describe('grammar build with kanji (QA round 2)', () => {
  const KANJI_ITEM = { en: 'I bought eggs.', jp: '{卵|たまご}を{買|か}いました。', tiles: ['卵を', '買いました。'], alternatives: ['卵、買いました。'], answers: ['たまごをかいました', 'たまごおかいました', 'たまごかいました'] };

  async function withKanji(grammarIntroduced: number): Promise<PreparedCard> {
    const p = await prep('build', { grammarIntroduced });
    if (p.view !== 'grammar-build') throw new Error(p.view);
    const plain = '卵を買いました。';
    return {
      ...p, item: KANJI_ITEM, shuffledTiles: ['買いました。', '卵を'], answer: plain,
      options: grammarIntroduced >= TYPED_BUILD_FROM ? [plain, 'ほんです。'] : [],
      rubyOf: { '卵を': '{卵|たまご}を', '買いました。': '{買|か}いました。', [plain]: KANJI_ITEM.jp },
    };
  }

  it('puts furigana on tiles and choices for kanji the learner has not met, and none for met ones (V043)', async () => {
    show(await withKanji(5));
    const tray = screen.getByRole('group', { name: 'Pieces' });
    await waitFor(() => expect(tray.querySelectorAll('rt')).toHaveLength(2));
    expect([...tray.querySelectorAll('rt')].map((rt) => rt.textContent)).toEqual(['か', 'たまご']);

    cleanup();
    await db.items.bulkPut([{ id: 'kanji:卵', kind: 'kanji', key: '卵', introducedAt: new Date() }, { id: 'kanji:買', kind: 'kanji', key: '買', introducedAt: new Date() }]);
    show(await withKanji(TYPED_BUILD_FROM));
    fireEvent.click(screen.getByRole('button', { name: 'Show options' }));
    const choices = screen.getByRole('group', { name: 'Answer choices' });
    await waitFor(() => expect(choices.querySelectorAll('rt')).toHaveLength(0));
    expect(within(choices).getByRole('button', { name: /卵を買いました/ })).toBeTruthy();
  });

  it('accepts a typed sentence with kanji: the canonical answer, an alternative, or mixed (V040)', async () => {
    expect(typedBuildMatches('卵を買いました。', KANJI_ITEM)).toBe(true);
    expect(typedBuildMatches('たまごを買いました', KANJI_ITEM)).toBe(true);
    expect(typedBuildMatches('卵、買いました', KANJI_ITEM)).toBe(true);
    expect(typedBuildMatches('卵を売りました。', KANJI_ITEM)).toBe(false);

    const onAnswer = show(await withKanji(TYPED_BUILD_FROM));
    const input = screen.getByLabelText('Type the sentence');
    fireEvent.change(input, { target: { value: '卵を買いました。' } });
    fireEvent.submit(input.closest('form')!);
    expect(onAnswer).toHaveBeenCalledWith({ grade: Rating.Good, mode: 'typed' });
  });
});
