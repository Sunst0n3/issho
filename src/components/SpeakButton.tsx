import { useEffect, useState } from 'react';
import { speak, stopSpeaking, ttsAvailable } from '../speech/tts.ts';
import { Icon } from './ui.tsx';

/** Plays Japanese text (ruby markup allowed) with the device's Japanese voice. */
export function SpeakButton({ text, label = 'Listen', rate, compact = false }: {
  text: string;
  label?: string;
  rate?: number;
  /** Icon-only round button instead of a labelled pill. */
  compact?: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => { if (playing) stopSpeaking(); }, [playing]);
  if (!ttsAvailable()) return null;

  const onClick = async () => {
    if (playing) { stopSpeaking(); setPlaying(false); return; }
    setPlaying(true);
    try { await speak(text, { rate }); } finally { setPlaying(false); }
  };

  return compact ? (
    <button type="button" className="icon-btn outlined" aria-label={playing ? 'Stop' : label} onClick={onClick}>
      <Icon name={playing ? 'stop' : 'speaker'} size={18} />
    </button>
  ) : (
    <button type="button" className="btn secondary small" onClick={onClick} aria-pressed={playing}>
      <Icon name={playing ? 'stop' : 'speaker'} size={16} />
      {playing ? 'Stop' : label}
    </button>
  );
}
