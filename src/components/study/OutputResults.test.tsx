import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db.ts';
import type { OutputSentenceRecord } from '../../lib/types.ts';
import { charDiff, fromLabel, markOutputResultsSeen, OutputResults, unseenOutputResults } from './OutputResults.tsx';
import { resetStudyDb } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);

function output(id: string, over: Partial<OutputSentenceRecord> = {}): OutputSentenceRecord {
  return {
    id, day: '2026-03-20', target: { ref: 'core:cw-0003', label: 'もう', en: 'already' }, draft: 'もうたべるでした',
    text: 'もうたべるでした', check: 'done', corrected: 'もうたべました', rule: 'Polite past: stem + ました.',
    createdAt: new Date(2026, 2, 20, 21), ...over,
  };
}

beforeEach(async () => {
  await resetStudyDb();
});

afterEach(() => {
  cleanup();
});

describe('charDiff', () => {
  it('keeps what is shared and marks what goes and what comes', () => {
    expect(charDiff('もうたべるでした', 'もうたべました')).toEqual([
      { op: 'same', text: 'もうたべ' }, { op: 'del', text: 'るで' }, { op: 'ins', text: 'ま' }, { op: 'same', text: 'した' },
    ]);
    expect(charDiff('ありがとう', 'ありがとう')).toEqual([{ op: 'same', text: 'ありがとう' }]);
    expect(charDiff('', 'ね')).toEqual([{ op: 'ins', text: 'ね' }]);
  });
});

describe('fromLabel', () => {
  it('says when the sentence was written', () => {
    expect(fromLabel('2026-03-21', '2026-03-21')).toBe('From earlier today');
    expect(fromLabel('2026-03-20', '2026-03-21')).toBe('From yesterday');
    expect(fromLabel('2026-03-17', '2026-03-21')).toBe('From Tuesday');
    expect(fromLabel('2026-03-01', '2026-03-21')).toBe('From earlier');
  });
});

describe('checked sentences', () => {
  it('lists only checks that came back unseen, oldest first, and each only once', async () => {
    await db.outputs.bulkPut([
      output('late', { createdAt: new Date(2026, 2, 20, 22) }),
      output('early', { createdAt: new Date(2026, 2, 19, 22), day: '2026-03-19' }),
      output('seen', { resultSeen: true }),
      output('waiting', { check: 'pending', corrected: undefined }),
      output('no-ai', { check: 'unavailable', corrected: undefined }),
    ]);
    expect((await unseenOutputResults()).map((r) => r.id)).toEqual(['early', 'late']);
    await markOutputResultsSeen(['early', 'late']);
    expect(await unseenOutputResults()).toEqual([]);
  });

  it('shows what was sent against the correction, the rule and the new card', () => {
    const onDone = vi.fn();
    render(<OutputResults results={[output('a', { cardId: 'sentence:custom-1|cloze' }), output('b', { text: 'はい。', corrected: 'はい。', rule: '' })]} onDone={onDone} />);
    expect(screen.getByRole('heading', { name: 'Your sentences were checked' })).toBeTruthy();
    expect(screen.getByText('るで', { selector: 'del' })).toBeTruthy();
    expect(screen.getByText('ま', { selector: 'ins' })).toBeTruthy();
    expect(document.body.textContent).toContain('Polite past: stem + ました.');
    expect(screen.getByText('The corrected sentence is now a card.')).toBeTruthy();
    expect(screen.getByText('Natural and correct')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
