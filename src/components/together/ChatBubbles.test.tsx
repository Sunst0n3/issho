import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../../sync/chat.ts';
import { MessageList, shownAt } from './ChatBubbles.tsx';

const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();

function item(id: number, patch: Partial<ChatItem> & { writtenAt?: string }): ChatItem {
  return {
    key: `c${id}`, id, clientId: `c${id}`, memberId: 'ken', createdAt: at(14, 9), kind: 'text', text: `msg ${id}`,
    status: 'sent', mine: false, ...patch,
  } as ChatItem;
}

function renderList(messages: ChatItem[]) {
  return render(<MessageList messages={messages} show="none" online senderName={() => 'Ken'} />);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MessageList', () => {
  it('shows when a message was written, not when the server got it', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 14, 12), toFake: ['Date'] });
    const wrote = at(14, 7, 30);
    renderList([item(1, { mine: true, memberId: 'me', createdAt: at(14, 9), writtenAt: wrote })]);
    const time = screen.getByText('msg 1').closest('.tg-bubble-row')!.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe(wrote);
    expect(shownAt({ createdAt: at(14, 9) })).toBe(at(14, 9));
  });

  it('keeps one separator per day when a message written offline arrives after newer ones', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 14, 12), toFake: ['Date'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderList([
        item(1, { createdAt: at(14, 8) }),
        // Written last night on a phone that was offline, delivered this morning.
        item(2, { mine: true, memberId: 'me', createdAt: at(14, 8, 5), writtenAt: at(13, 22, 40) }),
        item(3, { createdAt: at(14, 8, 10) }),
      ]);
      const days = [...document.querySelectorAll('.tg-day-sep')].map((d) => d.textContent);
      expect(days).toEqual(['Today']);
      // It sits under "Today", so its time says which day it really was.
      const late = screen.getByText('msg 2').closest('.tg-bubble-row')!.querySelector('time')!;
      expect(late.textContent).toMatch(/^Yesterday, /);
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('same key'))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('says why a message written for another household was not sent, and offers Retry', () => {
    renderList([item(1, { id: undefined, mine: true, memberId: 'me', status: 'failed', error: 'other_household' })]);
    expect(screen.getByRole('alert').textContent)
      .toContain('Not sent. It was written for another household. Retry sends it here.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
