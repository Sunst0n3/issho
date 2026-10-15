import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createEmptyCard, Rating, type Grade } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import type { CardRecord, CardType, ItemKind } from '../../../lib/types.ts';
import type { LeakMask } from '../../../srs/planner.ts';
import { seededRandom } from '../../../srs/random.ts';
import { audioMock, MNEMONICS, resetStudyDb } from '../test-utils.tsx';
import { FAST_AUTO_ADVANCE_MS, FeedbackPanel } from './FeedbackPanel.tsx';
import { prepareCard } from './prepare.ts';
import { ReviewCard } from './ReviewCard.tsx';
import type { PreparedCard } from './types.ts';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../writing/WritingPad.tsx', async () => (await import('../test-utils.tsx')).writingPadMock);
vi.mock('../../../speech/audio.ts', async () => (await import('../test-utils.tsx')).audioMock);

const NO_MASK: LeakMask = { readings: new Set(), meanings: new Set(), kanji: new Set() };
const known = { isKnown: () => true, introducedDay: () => '2026-10-01' };

async function prep(kind: ItemKind, key: string, type: CardType): Promise<PreparedCard> {
  const itemId = `${kind}:${key}`;
  const card: CardRecord = { ...createEmptyCard(new Date()), id: cardId(itemId, type), itemId, kind, type };
  const p = await prepareCard(card, { courseDay: 30, inSprint: false, taught: new Set(), grammarIntroduced: 5, handsBusy: false, known, random: seededRandom(2) });
  if (!p) throw new Error('missing');
  return p;
}

function panel(prepared: PreparedCard, { grade = Rating.Again as Grade, durationMs = 9000, medianMs = 8000, surprise = false, mask = NO_MASK } = {}) {
  const onContinue = vi.fn();
  render(<FeedbackPanel prepared={prepared} grade={grade} durationMs={durationMs} medianMs={medianMs} surprise={surprise}
    due={new Date(Date.now() + 4 * 86_400_000)} mask={mask} onContinue={onContinue} />);
  return onContinue;
}

beforeEach(async () => {
  await resetStudyDb({ audio: true });
  audioMock.play.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('FeedbackPanel', () => {
  it('a miss teaches: the stroke animation, the audio, the anchor in a sentence, and the hook', async () => {
    panel(await prep('kanji', '水', 'write'));
    expect(screen.getByText('Not quite')).toBeTruthy();
    expect(audioMock.play).toHaveBeenCalledWith({ ref: 'word:w-mizu' }, expect.anything());
    expect(await screen.findByRole('img', { name: /Stroke order of 水/ })).toBeTruthy();
    expect(await screen.findByText('In a sentence')).toBeTruthy();
    expect(screen.getByText('It is water.')).toBeTruthy();
    expect(screen.getByText(MNEMONICS['水'].meaning)).toBeTruthy();
    expect(screen.getByText(/Back in 4 days/)).toBeTruthy();
  });

  it('a miss lists the parts with their names', async () => {
    panel(await prep('kanji', '休', 'write'));
    expect(await screen.findByText('Parts')).toBeTruthy();
    expect(screen.getByText('person')).toBeTruthy();
    expect(screen.getByText('tree')).toBeTruthy();
    expect(screen.getByText('person (side)')).toBeTruthy();
  });

  it('a fast correct answer shows the one-line answer only and moves on by itself after 1.2 s', async () => {
    const prepared = await prep('word', 'w-ike', 'read');
    vi.useFakeTimers();
    const onContinue = panel(prepared, { grade: Rating.Good, durationMs: 2000, medianMs: 8000 });
    expect(screen.getByText('Correct')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByText('In a sentence')).toBeNull();
    act(() => vi.advanceTimersByTime(FAST_AUTO_ADVANCE_MS - 1));
    expect(onContinue).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('a slower correct answer waits for Continue', async () => {
    const onContinue = panel(await prep('word', 'w-ike', 'read'), { grade: Rating.Good, durationMs: 12_000, medianMs: 8000 });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('a surprise miss adds related words and a field for your own hook; the leak guard hides a sibling’s reading', async () => {
    const mask: LeakMask = { readings: new Set(['word:w-mizu']), meanings: new Set(), kanji: new Set() };
    panel(await prep('word', 'w-sui', 'read'), { surprise: true, mask });
    expect(screen.getByText('That one slipped')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Add your own memory hook/ })).toBeTruthy();
    const related = await screen.findByText('Also with 水');
    const list = related.closest('section')!;
    // 水 (its read card is due today): written, but not its reading.
    expect(list.textContent).toContain('水');
    expect(list.textContent).not.toContain('みず');
    expect(list.textContent).toContain('にほん');
  });

  it('saves the hook written after a surprise miss', async () => {
    await db.items.put({ id: 'word:w-sui', kind: 'word', key: 'w-sui', introducedAt: new Date() });
    panel(await prep('word', 'w-sui', 'read'), { surprise: true });
    fireEvent.click(await screen.findByRole('button', { name: /Add your own memory hook/ }));
    fireEvent.change(screen.getByLabelText('Your memory hook'), { target: { value: 'Water day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await db.items.get('word:w-sui'))?.customMnemonic).toBe('Water day'));
  });

  it('the hook is hidden on the test card and shown after a miss', async () => {
    const prepared = await prep('kanji', '水', 'write');
    render(<ReviewCard prepared={prepared} onAnswer={() => {}} />);
    expect(screen.queryByText(MNEMONICS['水'].meaning)).toBeNull();
    cleanup();
    panel(prepared);
    expect(await screen.findByText(MNEMONICS['水'].meaning)).toBeTruthy();
  });

  it('shows the calibration tip when "I wrote it right" is used on more than 10 % of writing answers', async () => {
    const base = { cardId: 'kanji:水|write', itemId: 'kanji:水', kind: 'kanji' as const, type: 'write' as const, grade: Rating.Hard as Grade, durationMs: 9000, mode: 'written' as const, prevState: 2, elapsedDays: 3, context: 'review' as const };
    await db.reviewLogs.bulkAdd(Array.from({ length: 20 }, (_, i) => ({ ...base, reviewedAt: new Date(Date.now() - i * 60_000), ...(i < 3 ? { override: true as const } : {}) })));
    panel(await prep('kanji', '水', 'write'));
    expect(await screen.findByText(/"I wrote it right" taps are above 10 %/)).toBeTruthy();
  });
});
