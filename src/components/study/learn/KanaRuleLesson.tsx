import { useState } from 'react';
import { clipRef } from '../../../../shared/voicevox.ts';
import type { KanaRule } from '../../../lib/types.ts';
import { usePlayback } from '../../../speech/audio.ts';
import { Icon } from '../../ui.tsx';
import { KanaText } from '../cards/KanaText.tsx';
import { MixedText } from '../MixedText.tsx';

/**
 * A kana rule (voiced sounds, small ゃゅょ, extended katakana): the explanation, every pair as a grid you can hear
 * (か→が), then the practice words: read each aloud first, then hear it.
 */
export function KanaRuleLesson({ rule, onDone }: { rule: KanaRule; onDone: () => void }) {
  const [stage, setStage] = useState<'pairs' | 'words'>('pairs');
  const [heard, setHeard] = useState<Set<number>>(new Set());
  const { play } = usePlayback();

  if (stage === 'pairs') {
    return (
      <>
        <article className="card st-lesson">
          <p className="label">New: {rule.script}</p>
          <h2 className="st-lesson-meaning"><MixedText text={rule.title} /></h2>
          <p className="st-explanation"><MixedText text={rule.explanation} /></p>
        </article>
        <section className="st-section" aria-labelledby={`pairs-${rule.id}`}>
          <h3 id={`pairs-${rule.id}`} className="label">Tap to hear each one</h3>
          <ul className="st-pairs">
            {rule.pairs.map((pair) => (
              // Both sides are their own tap target, so the learner hears the plain sound and the changed one.
              <li key={`${pair.from}>${pair.to}`} className="st-pair">
                <button type="button" className="st-pair-side st-pair-from" aria-label={`Hear ${pair.from}`}
                  onClick={() => void play({ ref: clipRef.kana(pair.from) }, { fallbackText: pair.from })}>
                  <span lang="ja">{pair.from}</span>
                </button>
                <span aria-hidden="true" className="st-pair-arrow">→</span>
                <button type="button" className="st-pair-side st-pair-to" aria-label={`Hear ${pair.to}`}
                  onClick={() => void play({ ref: clipRef.kana(pair.to) }, { fallbackText: pair.to })}>
                  <span lang="ja">{pair.to}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <div className="st-footer">
          <button type="button" className="btn ink st-grow" onClick={() => setStage('words')}>Read some words</button>
        </div>
      </>
    );
  }

  return (
    <>
      <section className="st-question">
        <h2 className="st-ask">Read each word aloud, then hear it</h2>
        <ul className="card st-words">
          {rule.practiceWords.map((w, n) => (
            <li key={w.kana}>
              <span className="st-word-text">
                <KanaText text={w.kana} className="st-word-written" />
                {heard.has(n) && <span className="st-word-en">{w.en}</span>}
              </span>
              <button type="button" className="icon-btn outlined" aria-label={`Hear ${w.kana}`}
                onClick={() => {
                  setHeard((h) => new Set(h).add(n));
                  void play({ ref: clipRef.kanaRule(rule.id, n) }, { fallbackText: w.kana });
                }}>
                <Icon name="speaker" size={18} />
              </button>
            </li>
          ))}
        </ul>
      </section>
      <div className="st-footer">
        <button type="button" className="btn ink st-grow" onClick={onDone}>Got it</button>
      </div>
    </>
  );
}
