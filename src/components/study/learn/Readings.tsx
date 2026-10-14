import { useSettings } from '../../../lib/hooks.ts';
import type { KanaEntry } from '../../../lib/types.ts';
import { kanaToRomaji } from '../format.ts';

/** 'た.べる' with the okurigana after the dot set apart. */
function Reading({ reading }: { reading: string }) {
  const clean = reading.replace(/-/g, '');
  const dot = clean.indexOf('.');
  if (dot < 0) return <>{clean}</>;
  return <>{clean.slice(0, dot)}<span className="st-okuri">{clean.slice(dot + 1)}</span></>;
}

/** KUN / ON rows: kana, with romaji when the learner wants it. */
export function Readings({ kun, on, kana, max = 3 }: {
  kun: readonly string[];
  on: readonly string[];
  kana: readonly KanaEntry[];
  max?: number;
}) {
  const { romaji } = useSettings();
  const rows = [
    { label: 'KUN', name: 'Japanese readings', list: kun.slice(0, max) },
    { label: 'ON', name: 'Chinese-derived readings', list: on.slice(0, max) },
  ].filter((r) => r.list.length);
  if (!rows.length) return null;
  return (
    <dl className="st-readings">
      {rows.map((row) => (
        <div key={row.label}>
          <dt><abbr title={row.name}>{row.label}</abbr></dt>
          <dd>
            {row.list.map((r, i) => (
              <span key={r} className="st-kanji-reading">
                {i > 0 && <span aria-hidden="true">、</span>}
                <span lang="ja"><Reading reading={r} /></span>
                {romaji && <span className="st-romaji">{kanaToRomaji(r, kana)}</span>}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}
