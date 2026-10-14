import { useState } from 'react';
import { Glyph } from '../components/Glyph.tsx';
import { SpeakButton } from '../components/SpeakButton.tsx';
import { BottomSheet } from '../components/home/BottomSheet.tsx';
import { Segmented } from '../components/home/controls.tsx';
import { PracticePad } from '../components/home/PracticePad.tsx';
import { chartRows } from '../components/home/kanaChart.ts';
import { useLive } from '../components/home/useLive.ts';
import { Screen, TopBar } from '../components/ui.tsx';
import { loadKana } from '../lib/data.ts';
import { db, getSettings } from '../lib/db.ts';
import type { KanaEntry, KanaKind, KanaScript } from '../lib/types.ts';
import { isYoon } from '../srs/items.ts';
import { StrokeAnimation, useStrokes } from '../writing/index.ts';
import '../components/home/home.css';
import '../components/home/library.css';

const SECTIONS: Array<{ title: string; kinds: KanaKind[]; columns: string }> = [
  { title: 'Basic', kinds: ['basic'], columns: 'aiueo' },
  { title: 'With marks (dakuten)', kinds: ['dakuten', 'handakuten'], columns: 'aiueo' },
  { title: 'Combinations (yōon)', kinds: ['yoon'], columns: 'auo' },
];

const KIND_TEXT: Record<KanaKind, string> = {
  basic: 'basic',
  dakuten: 'with dakuten (゛)',
  handakuten: 'with handakuten (゜)',
  yoon: 'combination',
};

function KanaStrokes({ char }: { char: string }) {
  const { strokes, loading } = useStrokes(char);
  if (loading) return <div className="hm-skeleton kd-strokes-skeleton" aria-hidden="true" />;
  if (!strokes) return <p className="muted">No stroke order for this character yet.</p>;
  return (
    <>
      <div className="kd-anim"><StrokeAnimation strokes={strokes} label={char} /></div>
      <h3 className="hm-section-title">Practice writing</h3>
      <PracticePad key={char} strokes={strokes} label={char} />
    </>
  );
}

function KanaSheet({ entry, learned, onClose }: { entry: KanaEntry; learned: boolean; onClose: () => void }) {
  const [base, small] = [...entry.char];
  return (
    <BottomSheet title={`${entry.char}, ${entry.romaji}`} onClose={onClose}>
      <div className="kana-sheet-head">
        <div className="kd-glyph small"><Glyph char={entry.char} size={64} /></div>
        <div className="kana-sheet-text">
          <p className="kana-sheet-romaji">{entry.romaji}</p>
          <p className="muted">
            {entry.script === 'hiragana' ? 'Hiragana' : 'Katakana'}, {KIND_TEXT[entry.kind]}
            {learned && <span className="chip ai kana-sheet-chip">Learned</span>}
          </p>
          <SpeakButton text={entry.char} />
        </div>
      </div>
      {isYoon(entry.char) ? (
        <p className="kana-yoon-note">
          Written as <span lang="ja">{base}</span> followed by a small <span lang="ja">{small}</span>,
          and said as one sound: {entry.romaji}. Practice the two parts on their own.
        </p>
      ) : (
        <KanaStrokes char={entry.char} />
      )}
    </BottomSheet>
  );
}

export default function KanaChart() {
  const [script, setScript] = useState<KanaScript>('hiragana');
  const [open, setOpen] = useState<KanaEntry>();
  const chart = useLive(async () => {
    const [kana, settings, ids] = await Promise.all([
      loadKana(),
      getSettings(),
      db.items.where('kind').equals('kana').primaryKeys(),
    ]);
    const learned = new Set(ids.map((id) => String(id).slice('kana:'.length)));
    const known = { hiragana: settings.knowsHiragana, katakana: settings.knowsKatakana };
    for (const k of kana) if (known[k.script]) learned.add(k.char);
    return { kana, learned };
  }, []);

  const data = chart.status === 'ready' ? chart.value : undefined;
  const entries = data?.kana.filter((k) => k.script === script) ?? [];
  const learnedCount = entries.filter((k) => data?.learned.has(k.char)).length;

  return (
    <Screen label="Kana chart">
      <TopBar back="/learn" title={<h1 className="lib-title">Kana chart</h1>} />
      <Segmented label="Script" value={script} onChange={setScript}
        options={[
          { value: 'hiragana', label: <><span lang="ja">ひらがな</span> Hiragana</> },
          { value: 'katakana', label: <><span lang="ja">カタカナ</span> Katakana</> },
        ]} />
      {data && <p className="muted lib-summary">{learnedCount} of {entries.length} learned. Tap one to hear it and practice writing.</p>}

      {chart.status === 'loading' && <div className="hm-skeleton card-sized" aria-busy="true" aria-label="Loading the chart" />}
      {chart.status === 'error' && (
        <section className="card hm-notice" role="alert">
          <h2 className="hm-notice-title">The chart didn't load</h2>
          <p className="muted">The kana data may still be downloading.</p>
          <button type="button" className="btn secondary small" onClick={chart.retry}>Try again</button>
        </section>
      )}

      {data && SECTIONS.map((section) => {
        const rows = chartRows(entries.filter((k) => section.kinds.includes(k.kind)), section.columns);
        if (!rows.length) return null;
        return (
          <section key={section.title} className="kana-section" aria-label={`${section.title}, ${script}`}>
            <h2 className="hm-section-title">{section.title}</h2>
            <div className={`kana-grid cols-${section.columns.length}`}>
              {rows.flat().map((e, i) => e ? (
                <button key={e.char} type="button" className={data.learned.has(e.char) ? 'kana-cell learned' : 'kana-cell'}
                  aria-label={`${e.char}, ${e.romaji}${data.learned.has(e.char) ? ', learned' : ''}`}
                  onClick={() => setOpen(e)}>
                  <span lang="ja" className="kana-char" aria-hidden="true">{e.char}</span>
                  <span className="kana-romaji" aria-hidden="true">{e.romaji}</span>
                </button>
              ) : (
                <span key={`gap-${i}`} className="kana-cell gap" aria-hidden="true" />
              ))}
            </div>
          </section>
        );
      })}

      {open && <KanaSheet entry={open} learned={Boolean(data?.learned.has(open.char))} onClose={() => setOpen(undefined)} />}
    </Screen>
  );
}
