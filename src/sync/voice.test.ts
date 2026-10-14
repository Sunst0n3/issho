import { Blob as NodeBlob } from 'node:buffer';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceUrl } from './voice.ts';

let created: Blob[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  // jsdom has no object URLs.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) {
      created.push(blob);
      return `blob:test/${created.length}`;
    }
    static revokeObjectURL(url: string) {
      revoked.push(url);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Each IndexedDB read hands back a new Blob object for the same stored recording.
const recording = () => new NodeBlob(['the same clip'], { type: 'audio/mp4' }) as unknown as Blob;

describe('useVoiceUrl', () => {
  it('plays a pending recording from its local blob and revokes the URL on unmount', async () => {
    const { result, unmount } = renderHook(() => useVoiceUrl(undefined, recording()));
    await waitFor(() => expect(result.current.url).toBe('blob:test/1'));
    unmount();
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('keeps the same URL while the chat list re-reads the same recording', async () => {
    // The outbox retry loop and incoming messages re-run the chat query; a new URL
    // each time would cut off playback of a pending voice message.
    const { result, rerender } = renderHook(({ blob }) => useVoiceUrl(undefined, blob), {
      initialProps: { blob: recording() },
    });
    await waitFor(() => expect(result.current.url).toBe('blob:test/1'));
    rerender({ blob: recording() });
    rerender({ blob: recording() });
    expect(result.current.url).toBe('blob:test/1');
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  it('switches to a different recording', async () => {
    const { result, rerender } = renderHook(({ blob }) => useVoiceUrl(undefined, blob), {
      initialProps: { blob: recording() },
    });
    await waitFor(() => expect(result.current.url).toBe('blob:test/1'));
    rerender({ blob: new NodeBlob(['another, longer clip'], { type: 'audio/mp4' }) as unknown as Blob });
    await waitFor(() => expect(result.current.url).toBe('blob:test/2'));
    expect(revoked).toEqual(['blob:test/1']);
  });
});
