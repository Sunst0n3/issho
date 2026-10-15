import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeakButton } from './SpeakButton.tsx';

const playback = vi.hoisted(() => ({
  playing: false,
  play: vi.fn(async () => ({ via: 'clip' as const, ms: 0, interrupted: false })),
  stop: vi.fn(),
}));

vi.mock('../speech/audio.ts', () => ({
  usePlayback: () => ({ play: playback.play, stop: playback.stop, playing: playback.playing }),
}));

beforeEach(() => {
  playback.playing = false;
  playback.play.mockClear();
  playback.stop.mockClear();
});
afterEach(cleanup);

describe('SpeakButton', () => {
  it('plays text through the playback API at the given rate', () => {
    render(<SpeakButton text="{今日|きょう}は" rate={0.9} />);
    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    expect(playback.play).toHaveBeenCalledWith({ text: '{今日|きょう}は' }, { rate: 0.9 });
  });

  it('passes the fallback text and voice for a clip that may not exist', () => {
    render(<SpeakButton source={{ ref: 'rp:rp-cafe#1' }} fallbackText="はい" voice="m" label="Hear it" />);
    fireEvent.click(screen.getByRole('button', { name: 'Hear it' }));
    expect(playback.play).toHaveBeenCalledWith({ ref: 'rp:rp-cafe#1' }, { rate: undefined, voice: 'm', fallbackText: 'はい' });
  });

  it('plays a clip source, and stops while playing', () => {
    playback.playing = true;
    render(<SpeakButton source={{ ref: 'core:cw-0001' }} compact label="Hear the word" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(playback.stop).toHaveBeenCalledTimes(1);
    expect(playback.play).not.toHaveBeenCalled();
  });

  it('names the labelled button by what a press does, not as a pressed toggle', () => {
    playback.playing = true;
    render(<SpeakButton text="はい" />);
    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(button);
    expect(playback.stop).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without anything to play', () => {
    const { container } = render(<SpeakButton text="  " />);
    expect(container.innerHTML).toBe('');
  });
});
