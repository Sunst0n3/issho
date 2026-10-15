// One line of a role-play: your line to say (with reading, meaning, hint and a
// speaking check), or your partner's line to listen to.

import { forwardRef, useState } from 'react';
import { useRubyShow } from '../../lib/hooks.ts';
import { parseRuby } from '../../lib/ruby.ts';
import type { RolePlay, RolePlayLine as Line } from '../../lib/types.ts';
import { SpeakButton } from '../SpeakButton.tsx';
import { Icon, Ruby } from '../ui.tsx';
import type { lineClip } from './rolePlay.ts';
import { SayIt, type Verdict } from './SayIt.tsx';

/** The ref is the line's <article>, for moving focus to it when the line changes. */
export const RolePlayLine = forwardRef<HTMLElement, {
  line: Line;
  roles: RolePlay['roles'];
  mine: boolean;
  /** One phone reading both parts: name the speaker instead of "your line". */
  readingBoth: boolean;
  /** Who says the other lines: "your partner" on one phone, their name on two. */
  partnerLabel: string;
  /** The line's pre-generated clip (role b in the second voice); without it the text is synthesized. */
  clip?: ReturnType<typeof lineClip>;
  onVerdict(verdict: Verdict): void;
}>(function RolePlayLine({ line, roles, mine, readingBoth, partnerLabel, clip, onVerdict }, ref) {
  const rubyShow = useRubyShow();
  const [showReading, setShowReading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const speaker = roles[line.role];
  const hasReadings = parseRuby(line.jp).some((s) => s.reading !== undefined);
  const audio = clip
    ? { source: { ref: clip.ref }, fallbackText: clip.text, voice: clip.voice }
    : { text: line.jp };

  if (mine) {
    return (
      <article ref={ref} tabIndex={-1} className="tg-rp-line tg-mine" aria-label={readingBoth ? `${speaker.name}'s line` : 'Your line'}>
        <p className="label">
          {readingBoth ? `${speaker.name}'s line` : `Your line · ${speaker.name}`}
        </p>
        <p className="tg-rp-jp"><Ruby text={line.jp} show={showReading ? 'all' : rubyShow} /></p>
        <p className="tg-rp-en">{line.en}</p>
        {line.hint && <p className="tg-rp-hint"><Icon name="bulb" size={16} /><span>{line.hint}</span></p>}
        <div className="tg-rp-tools">
          <SpeakButton {...audio} />
          {hasReadings && (
            <button type="button" className="btn secondary small" aria-pressed={showReading}
              onClick={() => setShowReading((v) => !v)}>
              {showReading ? 'Hide reading' : 'Show reading'}
            </button>
          )}
        </div>
        <SayIt expected={line.jp} onVerdict={onVerdict} />
      </article>
    );
  }

  return (
    <article ref={ref} tabIndex={-1} className="tg-rp-line tg-theirs" aria-label={`${speaker.name}'s line`}>
      <p className="label">{speaker.name}'s line</p>
      <h2 className="tg-rp-listen">Listen to {partnerLabel}</h2>
      {revealed ? (
        <>
          <p className="tg-rp-jp"><Ruby text={line.jp} show={rubyShow} /></p>
          <p className="tg-rp-en">{line.en}</p>
        </>
      ) : (
        <p className="muted">Try to follow by ear first. The words are here if you need them.</p>
      )}
      <div className="tg-rp-tools">
        {!revealed && (
          <button type="button" className="btn secondary small" onClick={() => setRevealed(true)}>
            <Icon name="eye" size={18} />Show line
          </button>
        )}
        <SpeakButton {...audio} label="Hear it" />
      </div>
    </article>
  );
});
