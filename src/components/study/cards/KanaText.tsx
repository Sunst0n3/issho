// Japanese text as a beginner can read it. During the kana sprint, kana not yet taught carry their romaji as small
// ruby (ありがとう on day 3: romaji over り and が only); after the sprint it is plain ruby text, never romaji.

import { Fragment } from 'react';
import { useRubyShow } from '../../../lib/hooks.ts';
import { parseRuby, romajiHelper } from '../../../lib/ruby.ts';
import type { RubyText } from '../../../lib/types.ts';
import { Ruby } from '../../ui.tsx';
import { useStudyDisplay } from '../display.ts';

type Show = 'all' | 'none' | ((base: string, reading?: string) => boolean);

export function KanaText({ text, show, className }: {
  text: RubyText;
  /** Which kanji readings to show; default: the learner's furigana setting. */
  show?: Show;
  className?: string;
}) {
  const { inSprint, taught, kana } = useStudyDisplay();
  const furigana = useRubyShow();
  const rule = show ?? furigana;
  if (!inSprint) return <Ruby text={text} show={rule} className={className} />;
  return (
    <span lang="ja" className={className ? `st-kanatext ${className}` : 'st-kanatext'}>
      {parseRuby(text).map((seg, i) => {
        if (seg.reading !== undefined) {
          const visible = rule === 'all' || (typeof rule === 'function' && rule(seg.text, seg.reading));
          return visible ? <ruby key={i}>{seg.text}<rt>{seg.reading}</rt></ruby> : <span key={i}>{seg.text}</span>;
        }
        return (
          <Fragment key={i}>
            {romajiHelper(seg.text, taught, kana).map((part, k) => (part.romaji
              ? <ruby key={k} className="st-romaji-ruby">{part.text}<rt lang="en">{part.romaji}</rt></ruby>
              : <Fragment key={k}>{part.text}</Fragment>))}
          </Fragment>
        );
      })}
    </span>
  );
}
