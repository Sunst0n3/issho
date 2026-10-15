// The kana placement check (onboarding, and Settings → re-check): 20 kana of one script. Each plays
// its sound and the learner writes it from memory on the recall pad. 18 or more right skips that
// script's sprint (its kana start as known reviews); otherwise the sprint teaches it. A pass taken back
// in onboarding (the script switched off again) is undone by withdrawPlacement.
import { useEffect, useRef, useState } from 'react';
import { clipRef } from '../../../shared/voicevox.ts';
import { loadKana, loadKanaRules } from '../../lib/data.ts';
import { db, itemId, updateSettings } from '../../lib/db.ts';
import type { KanaEntry, KanaScript, Settings } from '../../lib/types.ts';
import { play } from '../../speech/audio.ts';
import { applyPlacement, PLACEMENT_ITEMS, PLACEMENT_PASS, placementSet } from '../../srs/course.ts';
import { useStrokes, WritingPad, type RecallResult } from '../../writing/index.ts';
import { kanaSoundRow } from '../study/learn/data.ts';
import { Icon } from '../ui.tsx';

export type PlacementOutcome = 'known' | 'sprint';

export interface PlacementResult {
  script: KanaScript;
  correct: number;
  total: number;
  outcome: PlacementOutcome;
}

const SCRIPT_NAME: Record<KanaScript, string> = { hiragana: 'hiragana', katakana: 'katakana' };

/** "18/20 — you're past hiragana" or the sprint it leads to. */
export function placementText(r: PlacementResult, otherKnown: boolean): string {
  if (r.outcome === 'known') return `${r.correct}/${r.total} — you're past ${SCRIPT_NAME[r.script]}`;
  return `${r.correct}/${r.total} — let's do the ${otherKnown ? '7' : '14'}-day sprint`;
}

/**
 * Undoes a passed placement check: the script's kana and kana-rule items the check created (ItemRecord.via
 * 'placement'), their cards and any reviews of them go, and knowsHiragana/knowsKatakana is cleared, so the
 * sprint teaches the script. Items the course itself introduced stay. Returns the saved settings.
 */
export async function withdrawPlacement(script: KanaScript): Promise<Settings> {
  const [kana, rules] = await Promise.all([loadKana(), loadKanaRules()]);
  const ids = [
    ...kana.filter((k) => k.script === script && k.kind === 'basic').map((k) => itemId('kana', k.char)),
    ...rules.filter((r) => r.script === script).map((r) => itemId('kanaRule', r.id)),
  ];
  await db.transaction('rw', db.items, db.cards, db.reviewLogs, async () => {
    const placed = (await db.items.bulkGet(ids)).flatMap((i) => (i?.via === 'placement' ? [i.id] : []));
    if (!placed.length) return;
    await db.reviewLogs.where('itemId').anyOf(placed).delete();
    await db.cards.where('itemId').anyOf(placed).delete();
    await db.items.bulkDelete(placed);
  });
  return updateSettings(script === 'hiragana' ? { knowsHiragana: false } : { knowsKatakana: false });
}

export interface PlacementSummary { title: string; detail: string }

/** The result as onboarding words it: a pass skips the script's lessons, a fail leads to the sprint. */
function startSummary(r: PlacementResult, otherKnown: boolean): PlacementSummary {
  return {
    title: placementText(r, otherKnown),
    detail: r.outcome === 'known'
      ? `Your ${SCRIPT_NAME[r.script]} start as reviews, so the course skips those lessons.`
      : `The sprint teaches ${SCRIPT_NAME[r.script]} a few rows a day, with sound and a picture for each.`,
  };
}

function PlacementItem({ entry, row, index, total, onAnswer }: {
  entry: KanaEntry;
  /** The row a sound twin is written in (を → わ), as the review card and the memory pass name it. */
  row?: string;
  index: number;
  total: number;
  onAnswer: (ok: boolean) => void;
}) {
  const { strokes, loading } = useStrokes(entry.char);
  const [playing, setPlaying] = useState(false);
  const answered = useRef(false);
  const listen = async () => {
    setPlaying(true);
    try {
      await play({ ref: clipRef.kana(entry.char) }, { fallbackText: entry.char });
    } finally {
      setPlaying(false);
    }
  };
  // Each kana plays as it appears (the learner's tap on Start unlocked audio). Item components are
  // keyed by position, so this runs once per kana.
  const first = useRef(listen);
  useEffect(() => { void first.current(); }, []);

  const answer = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(ok);
  };

  return (
    <div className="hm-placement-item">
      <div className="hm-placement-head">
        <p className="hm-field-label" aria-live="polite">Kana {index + 1} of {total}</p>
        <button type="button" className="btn secondary small" onClick={() => void listen()} aria-pressed={playing}>
          <Icon name="speaker" size={16} />Play the sound
        </button>
      </div>
      <p className="hm-hint">
        Write the {SCRIPT_NAME[entry.script]} for the sound you hear{row && <> (<span lang="ja">{row}</span> row)</>}, then tap Done.
      </p>
      {loading && <div className="hm-skeleton hm-pad-skeleton" aria-hidden="true" />}
      {!loading && strokes && (
        // A kana drawn after the pad's Hint showed its strokes was copied, not recalled: it doesn't count.
        <WritingPad strokes={strokes} mode="recall" label={`the ${SCRIPT_NAME[entry.script]} for the sound you heard`}
          onRecallDone={(r: Pick<RecallResult, 'match' | 'hintUsed'>) => answer(r.match.ok && !r.hintUsed)} />
      )}
      {!loading && !strokes && <p className="muted">This kana can't be checked here.</p>}
      <button type="button" className="btn ghost small" onClick={() => answer(false)}>I don't know this one</button>
    </div>
  );
}

/** What a pass does, as the intro says it before the check: onboarding's wording by default. */
export function passNoteText(script: KanaScript): string {
  return `${PLACEMENT_PASS} or more right and you skip the ${SCRIPT_NAME[script]} lessons.`;
}

export function PlacementCheck({ script, otherKnown = false, summary, passNote, onDone, onCancel }: {
  script: KanaScript;
  /** The other script is known: a failed check leads to a 7-day sprint. */
  otherKnown?: boolean;
  /** How the result reads; onboarding's wording (pass → skip the lessons, fail → the sprint) by default. */
  summary?: (result: PlacementResult) => PlacementSummary;
  /** What a pass does, in the intro (passNoteText by default): a re-check after the lessons words it otherwise. */
  passNote?: string;
  onDone: (result: PlacementResult) => void;
  onCancel?: () => void;
}) {
  const [items, setItems] = useState<KanaEntry[]>();
  /** Every kana, to name the row of a sound twin. */
  const [allKana, setAllKana] = useState<KanaEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [result, setResult] = useState<PlacementResult>();
  const [saveError, setSaveError] = useState(false);
  const applied = useRef(false);

  useEffect(() => {
    let live = true;
    loadKana().then(
      (kana) => {
        if (!live) return;
        setAllKana(kana);
        setItems(placementSet(kana, script));
      },
      () => { if (live) setLoadError(true); },
    );
    return () => { live = false; };
  }, [script]);

  const finish = async (score: number, total: number) => {
    // Applied once, even if the last answer is reported twice.
    if (applied.current) return;
    applied.current = true;
    setSaveError(false);
    try {
      const outcome = await applyPlacement(script, score);
      setResult({ script, correct: score, total, outcome });
    } catch {
      applied.current = false;
      setSaveError(true);
    }
  };

  const onAnswer = (ok: boolean) => {
    const total = items?.length ?? PLACEMENT_ITEMS;
    const score = correct + (ok ? 1 : 0);
    setCorrect(score);
    if (index + 1 >= total) void finish(score, total);
    else setIndex(index + 1);
  };

  if (loadError) {
    return <p className="hm-error" role="alert">The kana didn't load. Check that the app has finished downloading.</p>;
  }
  if (!items) return <div className="hm-skeleton card-sized" aria-busy="true" aria-label="Loading the check" />;

  if (result) {
    const { title, detail } = (summary ?? ((r: PlacementResult) => startSummary(r, otherKnown)))(result);
    return (
      <section className="card hm-placement-result" aria-labelledby="placement-result">
        <h2 id="placement-result" className="hm-notice-title" tabIndex={-1}>{title}</h2>
        <p className="hm-hint">{detail}</p>
        <button type="button" className="btn primary block" onClick={() => onDone(result)}>Continue</button>
      </section>
    );
  }

  if (!started) {
    return (
      <section className="card hm-placement-intro" aria-labelledby="placement-intro">
        <h2 id="placement-intro" className="hm-notice-title">Quick {SCRIPT_NAME[script]} check</h2>
        <p className="hm-hint">
          You'll hear {items.length} sounds. Write each one from memory (one written after a hint doesn't
          count). {passNote ?? passNoteText(script)} About 3 minutes.
        </p>
        <div className="hm-prompt-actions">
          <button type="button" className="btn primary small" onClick={() => setStarted(true)}>Start the check</button>
          {onCancel && <button type="button" className="btn ghost small" onClick={onCancel}>Skip the check</button>}
        </div>
      </section>
    );
  }

  return (
    <section className="hm-placement" aria-label={`${SCRIPT_NAME[script]} check`}>
      <PlacementItem key={index} entry={items[index]} row={kanaSoundRow(items[index], allKana)} index={index} total={items.length}
        onAnswer={onAnswer} />
      {saveError && (
        <p className="hm-error" role="alert">
          Couldn't save the result on this phone.{' '}
          <button type="button" className="btn ghost small" onClick={() => void finish(correct, items.length)}>Try again</button>
        </p>
      )}
    </section>
  );
}
