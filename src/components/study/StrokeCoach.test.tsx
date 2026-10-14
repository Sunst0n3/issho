import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeStroke, mistakeMessage } from '../../writing/describe.ts';
import { PracticePad } from './PracticePad.tsx';
import { resetStudyDb, STROKES } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);

const coach = () => document.querySelector('.st-coach')?.textContent;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

beforeEach(async () => {
  await resetStudyDb();
  localStorage.setItem('issho.write.mode', 'guided');
});

afterEach(() => {
  cleanup();
});

describe('stroke coach', () => {
  it('stays on the expected stroke after Undo and describes the stroke a Hint shows', async () => {
    render(<PracticePad char="あ" ask="Write the hiragana for" target="a" label={'the hiragana for "a"'} />);
    const [first, second] = STROKES['あ'];
    await screen.findByRole('img', { name: 'Writing pad for the hiragana for "a" (guided)' });
    expect(coach()).toBe(`Start at the dot: 3 strokes.First: ${capitalized(describeStroke(first))}.`);

    click('Draw a stroke');
    expect(coach()).toBe(`Stroke 1 looks good.Next: ${describeStroke(second)}.`);
    click('Undo');
    // Back to the first stroke, not "Stroke 1 looks good. Next: (stroke 2)".
    expect(coach()).toBe(`Start at the dot: 3 strokes.First: ${capitalized(describeStroke(first))}.`);

    click('Draw a stroke');
    click('Draw a stroke');
    click('Undo');
    expect(coach()).toBe(`Back to stroke 2 of 3.Next: ${describeStroke(second)}.`);
    click('Hint');
    expect(coach()).toBe(`Here is stroke 2.${capitalized(describeStroke(second))}.`);

    click('Clear');
    expect(coach()).toBe(`Start at the dot: 3 strokes.First: ${capitalized(describeStroke(first))}.`);
  });

  it('only says to watch the hint once a hint is showing', async () => {
    render(<PracticePad char="あ" ask="Write the hiragana for" target="a" label={'the hiragana for "a"'} />);
    await screen.findByRole('img', { name: /Writing pad/ });
    click('Miss the shape');
    expect(coach()).toBe('The shape is off. Try that stroke again.');
    // A second miss on the same stroke shows it automatically (AUTO_HINT_AFTER).
    click('Miss the shape');
    expect(coach()).toBe('The shape is off. Watch the hint and try again.');

    click('Draw a stroke');
    click('Miss the shape');
    expect(coach()).toBe('The shape is off. Try that stroke again.');
    click('Hint');
    click('Miss the shape');
    expect(coach()).toBe('The shape is off. Watch the hint and try again.');
  });

  it('mistakeMessage mentions the hint only when it is shown', () => {
    const shape = { ok: false, score: 0.2, reason: 'shape' as const };
    expect(mistakeMessage(shape, 0)).toBe('The shape is off. Try that stroke again.');
    expect(mistakeMessage(shape, 0, true)).toBe('The shape is off. Watch the hint and try again.');
  });
});

describe('practice pad', () => {
  it('names the pad by what to write once the character is hidden, and paper mode can start over', async () => {
    render(<PracticePad char="水" ask="Write the kanji for" target="water" label={'the kanji for "water" (みず)'} />);
    expect(screen.getByRole('region', { name: 'Practice writing 水' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Trace' }));
    expect(await screen.findByRole('img', { name: 'Writing pad for 水 (trace)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Memory' }));
    expect(await screen.findByRole('img', { name: 'Writing pad for the kanji for "water" (みず) (memory)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Paper' }));
    click('Show the strokes');
    expect(screen.getByRole('img', { name: /Stroke order animation for 水/ })).toBeTruthy();
    click('Write it again');
    expect(screen.queryByRole('img', { name: /Stroke order animation/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the strokes' })).toBeTruthy();
  });
});
