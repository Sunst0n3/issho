// One line of a role-play: your line to say (with reading, meaning, hint and a
// speaking check), or your partner's line to listen to.

import { useState } from 'react';
import { useRubyShow } from '../../lib/hooks.ts';
import { parseRuby } from '../../lib/ruby.ts';
import type { RolePlay, RolePlayLine as Line } from '../../lib/types.ts';
import { SpeakButton } from '../SpeakButton.tsx';
import { Icon, Ruby } from '../ui.tsx';
import { SayIt, type Verdict } from './SayIt.tsx';

export function RolePlayLine({ line, roles, mine, readingBoth, partnerLabel, onVerdict }: {
  line: Line;
  roles: RolePlay['roles'];
  mine: boolean;
  /** One phone reading both parts: name the speaker instead of "your line". */
  readingBoth: boolean;
  /** Who says the other lines: "your partner" on one phone, their name on two. */
  partnerLabel: string;
  onVerdict(verdict: Verdict): void;
}) {
  const rubyShow = useRubyShow();
  const [showReading, setShowReading] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const speaker = roles[line.role];
  const hasReadings = parseRuby(line.jp).some((s) => s.reading !== undefined);

  if (mine) {
    return (
      <article className="tg-rp-line tg-mine" aria-label={readingBoth ? `${speaker.name}'s line` : 'Your line'}>
        <p className="label">
          {readingBoth ? `${speaker.name}'s line` : `Your line · ${speaker.name}`}
        </p>
        <p className="tg-rp-jp"><Ruby text={line.jp} show={showReading ? 'all' : rubyShow} /></p>
        <p className="tg-rp-en">{line.en}</p>
        {line.hint && <p className="tg-rp-hint"><Icon name="bulb" size={16} /><span>{line.hint}</span></p>}
        <div className="tg-rp-tools">
          <SpeakButton text={line.jp} />
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
    <article className="tg-rp-line tg-theirs" aria-label={`${speaker.name}'s line`}>
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
        <SpeakButton text={line.jp} label="Hear it" />
      </div>
    </article>
  );
}
