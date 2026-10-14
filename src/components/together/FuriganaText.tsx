import { segmentFurigana, type FuriganaDict } from './furigana.ts';

/**
 * Free Japanese text with readings over kanji runs. `show` picks which runs get
 * them ('all', or a predicate on the run, e.g. "has a kanji I don't know").
 * Without a dictionary (or with 'none') the text renders as-is.
 */
export function FuriganaText({ text, dict, show, className }: {
  text: string;
  dict?: FuriganaDict;
  show: 'all' | 'none' | ((base: string) => boolean);
  className?: string;
}) {
  if (!dict || show === 'none') return <span lang="ja" className={className}>{text}</span>;
  return (
    <span lang="ja" className={className}>
      {segmentFurigana(text, dict).map((seg, i) =>
        seg.reading && (show === 'all' || show(seg.text))
          ? <ruby key={i}>{seg.text}<rt>{seg.reading}</rt></ruby>
          : <span key={i}>{seg.text}</span>)}
    </span>
  );
}
