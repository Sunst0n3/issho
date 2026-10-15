// Stroke-order coaching after a recall (V024): a correct answer with order slips keeps its feedback on screen.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Rating } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritingPadProps } from '../../../writing/WritingPad.tsx';
import { resetStudyDb } from '../test-utils.tsx';
import type { CardAnswer } from './types.ts';
import { WriteQuestion } from './WriteQuestion.tsx';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../speech/audio.ts', async () => (await import('../test-utils.tsx')).audioMock);
vi.mock('../../../writing/WritingPad.tsx', () => ({
  AUTO_HINT_AFTER: 2,
  /** Recall pad stand-in: every stroke right, with or without stroke 2 drawn before stroke 1. */
  WritingPad: ({ strokes, onRecallDone }: WritingPadProps) => {
    const done = (orderSlips: { expected: number; drawnAt: number }[]) => onRecallDone?.({
      strokes: [], hintUsed: false,
      match: { ok: true, missing: [], extra: [], unmatched: [], orderSlips, assignment: strokes.map((_, i) => i) },
    });
    return (
      <div>
        <button type="button" onClick={() => done([])}>Write it in order</button>
        <button type="button" onClick={() => done([{ expected: 0, drawnAt: 1 }])}>Write it out of order</button>
      </div>
    );
  },
}));

beforeEach(async () => {
  await resetStudyDb();
});

afterEach(() => {
  cleanup();
});

describe('WriteQuestion', () => {
  it('asks the feedback to wait for Continue when the recall had stroke-order slips (V024)', async () => {
    const onAnswer = vi.fn<(a: CardAnswer) => void>();
    render(<WriteQuestion char="人" ask="Write the kanji" target={<span>person</span>} label="the kanji for person" onAnswer={onAnswer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Write it out of order' }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ grade: Rating.Good, mode: 'written', hold: true }));

    cleanup();
    const inOrder = vi.fn<(a: CardAnswer) => void>();
    render(<WriteQuestion char="人" ask="Write the kanji" target={<span>person</span>} label="the kanji for person" onAnswer={inOrder} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Write it in order' }));
    expect(inOrder.mock.calls[0][0]).not.toHaveProperty('hold');
  });
});
