import type { VoiceId } from '../../shared/api.ts';
import { usePlayback, type AudioSource } from '../speech/audio.ts';
import { Icon } from './ui.tsx';

/**
 * Plays Japanese: a pre-generated clip when there is one, else the home server's voice, else the
 * device's. Give a clip `source` ({ ref } or { text, voice }) or plain `text` (ruby markup allowed).
 * A { ref } source with `fallbackText` is spoken (in `voice`) when that clip does not exist.
 */
export function SpeakButton({ source, text, fallbackText, voice, label = 'Listen', rate, compact = false }: {
  source?: AudioSource;
  text?: string;
  /** For a { ref } source without a clip: the text to synthesize instead. */
  fallbackText?: string;
  /** Voice for synthesized text (clips carry their own); default 'f'. */
  voice?: VoiceId;
  label?: string;
  /** Default: the automatic rate (slower in the first 90 course days, or Settings). */
  rate?: number;
  /** Icon-only round button instead of a labelled pill. */
  compact?: boolean;
}) {
  const { play, stop, playing } = usePlayback();
  const what: AudioSource | null = source ?? (text?.trim() ? { text } : null);
  if (!what) return null;

  const onClick = () => {
    if (playing) { stop(); return; }
    void play(what, { rate, voice, fallbackText });
  };

  // The name itself says what a press does ("Listen" or "Stop"), so no aria-pressed: a toggle
  // button whose name changes would be announced as "Stop, pressed".
  return compact ? (
    <button type="button" className="icon-btn outlined" aria-label={playing ? 'Stop' : label} onClick={onClick}>
      <Icon name={playing ? 'stop' : 'speaker'} size={18} />
    </button>
  ) : (
    <button type="button" className="btn secondary small" onClick={onClick}>
      <Icon name={playing ? 'stop' : 'speaker'} size={16} />
      {playing ? 'Stop' : label}
    </button>
  );
}
