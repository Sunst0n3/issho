// The pitch-ear drill: hear a word followed by が (a verified pre-generated clip, never a synthesized voice), then
// tap the height line that matches. Heiban and odaka words sound the same alone; with が they differ (が stays high
// after heiban, drops after odaka), so every option is drawn over the word's moras plus が. A Leitner box per word.

import { useEffect, useRef, useState } from 'react';
import { dayKey, db } from '../../lib/db.ts';
import { loadAccent, loadAudioManifest, loadWordInfo } from '../../lib/data.ts';
import type { AccentInfo, AccentType } from '../../lib/types.ts';
import { logFluency } from '../../srs/fluency.ts';
import { pickPitchDrill, pitchCandidates, pitchOptions, recordPitch, type PitchItem } from '../../srs/pitch.ts';
import { loadKnownWords } from '../../srs/readListen.ts';
import { hasClip, usePlayback } from '../../speech/audio.ts';
import { Icon } from '../ui.tsx';
import { useScrollToTop } from './focus.ts';
import { PitchLine } from './PitchLine.tsx';
import { useAsync } from './useAsync.ts';

/** pure: the accent type of a word of n moras with nucleus `drop`. */
export function accentType(drop: number, moraCount: number): AccentType {
  if (drop === 0) return 'heiban';
  if (drop === 1) return 'atamadaka';
  return drop === moraCount ? 'odaka' : 'nakadaka';
}

/** Today's drill items, only words whose word + が clip exists. Empty when not every picked item has one. */
export async function loadPitchDrill(now: Date = new Date()): Promise<PitchItem[]> {
  const [accent, manifest, known, info, boxes] = await Promise.all([
    loadAccent(), loadAudioManifest(), loadKnownWords(now), loadWordInfo(), db.pitchBoxes.toArray(),
  ]);
  const cands = pitchCandidates(accent, manifest, (ref) => known.isKnown(ref), info);
  const items = pickPitchDrill(cands, new Map(boxes.map((b) => [b.ref, b])), dayKey(now), Math.random);
  const clips = await Promise.all(items.map((i) => hasClip({ ref: i.clipRef })));
  return clips.every(Boolean) ? items : [];
}

function Item({ item, onAnswered }: { item: PitchItem; onAnswered: (correct: boolean) => void }) {
  const { play, playing } = usePlayback();
  const [picked, setPicked] = useState<number | null>(null);
  const n = item.accent.moras.length;
  const hear = () => void play({ ref: item.clipRef });
  useEffect(() => {
    hear();
    // Played once when the word appears; Replay plays it again.
  }, [item.ref]);
  const pick = (drop: number) => {
    if (picked !== null) return;
    setPicked(drop);
    onAnswered(drop === item.accent.drop);
  };
  return (
    <section className="st-question">
      <h2 className="st-ask">Which line did you hear?</h2>
      <div className="card st-prompt">
        <p className="st-big st-fit" lang="ja">{item.kana}が</p>
        <button type="button" className="btn secondary small" onClick={hear} aria-pressed={playing}>
          <Icon name="speaker" size={16} />Replay
        </button>
      </div>
      <div className="st-pitch-options" role="group" aria-label="Pitch options">
        {pitchOptions(n).map((drop) => {
          const accent: AccentInfo = { moras: item.accent.moras, drop, type: accentType(drop, n), withGa: true };
          const state = picked === null ? '' : drop === item.accent.drop ? ' correct' : drop === picked ? ' wrong' : ' st-dim';
          return (
            <button key={drop} type="button" className={`choice st-pitch-option${state}`} aria-disabled={picked !== null || undefined}
              onClick={() => pick(drop)} data-drop={drop}>
              <PitchLine accent={accent} kana={item.kana} particle size="sm" />
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className={picked === item.accent.drop ? 'feedback good' : 'feedback bad'} role="status">
          <p className="st-fb-title">{picked === item.accent.drop ? 'Yes' : 'Not quite: listen once more'}</p>
          <p className="st-fb-note"><span lang="ja">{item.written}</span></p>
        </div>
      )}
    </section>
  );
}

export function PitchDrill({ items: given, onDone }: {
  /** The drill's words; loaded for today when left out. */
  items?: readonly PitchItem[];
  onDone: () => void;
}) {
  const loaded = useAsync(() => (given ? Promise.resolve([...given]) : loadPitchDrill()), [given]);
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState(false);
  const correct = useRef(0);
  const logged = useRef(false);
  useScrollToTop(at);

  if (loaded.loading) return <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Loading the pitch drill" />;
  const items = loaded.data ?? [];
  const finish = () => {
    if (!logged.current && items.length) {
      logged.current = true;
      void logFluency('pitch', correct.current).catch((e: unknown) => console.warn('could not log the drill', e));
    }
    onDone();
  };
  if (!items.length) {
    return (
      <div className="st-reading">
        <p className="card st-note">No pitch drill today: the recordings it needs aren't on this phone yet.</p>
        <div className="st-footer"><button type="button" className="btn ink st-grow" onClick={onDone}>Continue</button></div>
      </div>
    );
  }
  const item = items[at];
  return (
    <div className="st-reading">
      <p className="label">Pitch · {at + 1} / {items.length}</p>
      <Item key={item.ref} item={item} onAnswered={(ok) => {
        setAnswered(true);
        if (ok) correct.current++;
        void recordPitch(item.ref, ok).catch((e: unknown) => console.warn('could not record the answer', e));
      }} />
      {answered && (
        <div className="st-footer">
          <button type="button" className="btn ink st-grow" onClick={() => {
            setAnswered(false);
            if (at + 1 < items.length) setAt(at + 1);
            else finish();
          }}>{at + 1 < items.length ? 'Next' : 'Done'}</button>
        </div>
      )}
    </div>
  );
}
