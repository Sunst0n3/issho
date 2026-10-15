// Plays a pre-generated clip by ref (or any Japanese text), falling back to the server voice and then the device
// voice. A second tap stops it.

import type { RubyText } from '../../lib/types.ts';
import { usePlayback, type AudioSource } from '../../speech/audio.ts';
import { Icon } from '../ui.tsx';

export function AudioButton({ source, fallbackText, label = 'Listen', compact = false, rate, className }: {
  source: AudioSource;
  /** For a clip ref with no clip yet: the text to synthesize instead. */
  fallbackText?: RubyText;
  label?: string;
  /** Icon-only round button instead of a labelled pill. */
  compact?: boolean;
  rate?: number;
  className?: string;
}) {
  const { play, stop, playing } = usePlayback();
  const onClick = () => {
    if (playing) {
      stop();
      return;
    }
    void play(source, { ...(fallbackText ? { fallbackText } : {}), ...(rate ? { rate } : {}) });
  };
  return compact ? (
    <button type="button" className={`icon-btn outlined${className ? ` ${className}` : ''}`} aria-label={playing ? 'Stop' : label} onClick={onClick}>
      <Icon name={playing ? 'stop' : 'speaker'} size={18} />
    </button>
  ) : (
    <button type="button" className={`btn secondary small${className ? ` ${className}` : ''}`} onClick={onClick} aria-pressed={playing}>
      <Icon name={playing ? 'stop' : 'speaker'} size={16} />
      {playing ? 'Stop' : label}
    </button>
  );
}
