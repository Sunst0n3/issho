import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecorderError, startRecording, type Recording } from '../../speech/recorder.ts';
import { Shadow } from './Shadow.tsx';

vi.mock('../../speech/recorder.ts', async (original) => ({
  ...(await original<typeof import('../../speech/recorder.ts')>()),
  micAvailable: () => true,
  startRecording: vi.fn(),
}));
vi.mock('../../speech/recognition.ts', () => ({ recognitionAvailable: () => false, listen: vi.fn() }));
vi.mock('../../speech/tts.ts', () => ({ speak: vi.fn(async () => {}), stopSpeaking: vi.fn(), ttsAvailable: () => true }));

/** A recording that finishes when stopped. */
function fakeTake() {
  let finish: (blob: Blob) => void = () => {};
  const done = new Promise<Blob>((resolve) => {
    finish = resolve;
  });
  return {
    mimeType: 'audio/webm',
    done,
    stop: vi.fn(() => {
      finish(new Blob(['take']));
      return done;
    }),
    cancel: vi.fn(),
    level: () => 0.5,
    elapsed: () => 0,
  } satisfies Recording;
}

const shadowButton = () => screen.getByRole('button', { name: 'Shadow: say it yourself' });

beforeEach(() => {
  vi.mocked(startRecording).mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:take');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('Shadow', () => {
  it('records a take, offers it back, and frees the audio when it goes away', async () => {
    const take = fakeTake();
    vi.mocked(startRecording).mockResolvedValue(take);
    const view = render(<Shadow text="{水|みず}をのむ。" />);

    fireEvent.click(shadowButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('button', { name: 'Record again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yours' })).toBeTruthy();

    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:take');
  });

  it('says so when the microphone is not allowed', async () => {
    vi.mocked(startRecording).mockRejectedValue(new RecorderError('denied'));
    render(<Shadow text="{水|みず}をのむ。" />);
    fireEvent.click(shadowButton());
    expect((await screen.findByRole('alert')).textContent).toContain('Microphone access is off');
    expect(shadowButton()).toBeTruthy();
  });

  it('turns the microphone off when the sentence is left during the permission prompt', async () => {
    const take = fakeTake();
    let grant: (take: Recording) => void = () => {};
    vi.mocked(startRecording).mockReturnValue(new Promise((resolve) => {
      grant = resolve;
    }));
    const view = render(<Shadow text="{水|みず}をのむ。" />);
    fireEvent.click(shadowButton());
    view.unmount();

    grant(take);
    await waitFor(() => expect(take.cancel).toHaveBeenCalledTimes(1));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
