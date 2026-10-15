import { useState } from 'react';
import { clipRef } from '../../shared/voicevox.ts';
import { Link } from 'react-router-dom';
import { Glyph } from '../components/Glyph.tsx';
import { BottomSheet } from '../components/home/BottomSheet.tsx';
import { Segmented } from '../components/home/controls.tsx';
import { chartRows } from '../components/home/kanaChart.ts';
import { useLive } from '../components/home/useLive.ts';
import { Icon, Screen, TopBar } from '../components/ui.tsx';
import { loadKana } from '../lib/data.ts';
import { getSettings } from '../lib/db.ts';
import type { KanaEntry, KanaKind, KanaScript } from '../lib/types.ts';
import { play } from '../speech/audio.ts';
import { taughtKana } from '../srs/course.ts';
import { StrokeAnimation, useStrokes } from '../writing/index.ts';
import '../components/home/home.css';
import '../components/home/library.css';

// The kana chart is the one place romaji is shown after the kana sprint.

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

/** A yōon is two kana (きゃ): written as its parts. */
const isCombination = (entry: KanaEntry) => [...entry.char].length > 1;

function playKana(char: string) {
  return play({ ref: clipRef.kana(char) }, { fallbackText: char });
}

function KanaStrokes({ char }: { char: string }) {
  const { strokes, loading } = useStrokes(char);
  if (loading) return <div className="hm-skeleton kd-strokes-skeleton" aria-hidden="true" />;
  if (!strokes) return <p className="muted">No stroke order for this character yet.</p>;
  return <div className="kd-anim"><StrokeAnimation strokes={strokes} label={char} /></div>;
}

function KanaSheet({ entry, learned, onClose }: { entry: KanaEntry; learned: boolean; onClose: () => void }) {
  const [base, small] = [...entry.char];
  const [playing, setPlaying] = useState(false);
  const listen = async () => {
    setPlaying(true);
    try {
      await playKana(entry.char);
    } finally {
      setPlaying(false);
    }
  };
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
          <button type="button" className="btn secondary small" onClick={() => void listen()} aria-pressed={playing}>
            <Icon name="speaker" size={16} />Listen
          </button>
        </div>
      </div>
      {isCombination(entry) ? (
        <p className="kana-yoon-note">
          Written as <span lang="ja">{base}</span> followed by a small <span lang="ja">{small}</span>,
          and said as one sound: {entry.romaji}. Practice the two parts on their own.
        </p>
      ) : (
        <>
          <KanaStrokes char={entry.char} />
          <Link to={`/write/${encodeURIComponent(entry.char)}`} className="btn secondary block">
            <Icon name="pen" size={18} />Practice writing
          </Link>
        </>
      )}
    </BottomSheet>
  );
}

export default function KanaChart() {
  const [script, setScript] = useState<KanaScript>('hiragana');
  const [open, setOpen] = useState<KanaEntry>();
  const chart = useLive(async () => {
    // Basic kana are items of their own; voiced and combination kana come with their rule lesson.
    const [kana, settings, learned] = await Promise.all([loadKana(), getSettings(), taughtKana()]);
    const known = { hiragana: settings.knowsHiragana, katakana: settings.knowsKatakana };
    for (const k of kana) if (known[k.script]) learned.add(k.char);
    return { kana, learned };
  }, []);

  const data = chart.status === 'ready' ? chart.value : undefined;
  const entries = data?.kana.filter((k) => k.script === script) ?? [];
  const learnedCount = entries.filter((k) => data?.learned.has(k.char)).length;

  const choose = (entry: KanaEntry) => {
    setOpen(entry);
    // Tapping a kana says it.
    void playKana(entry.char);
  };

  return (
    <Screen label="Kana chart">
      <TopBar back="/learn" title="Kana chart" />
      <Segmented label="Script" value={script} onChange={setScript}
        options={[
          { value: 'hiragana', label: <><span lang="ja">ひらがな</span> Hiragana</> },
          { value: 'katakana', label: <><span lang="ja">カタカナ</span> Katakana</> },
        ]} />
      {data && <p className="muted lib-summary">{learnedCount} of {entries.length} learned. Tap one to hear it and see how it's written.</p>}

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
                  onClick={() => choose(e)}>
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
