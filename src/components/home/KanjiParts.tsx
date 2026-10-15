// Pieces of the kanji page: readings, memory hook, the learner's card status and the handwriting pin.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dayKey, db } from '../../lib/db.ts';
import type { CardRecord, ItemRecord, MnemonicEntry } from '../../lib/types.ts';
import { setPinned } from '../../srs/items.ts';
import { daysBetween } from '../../srs/days.ts';
import { focusLost } from '../together/focus.ts';
import { Icon } from '../ui.tsx';
import { Switch } from './controls.tsx';

/** Longest memory hook a learner can write (the lesson's hook editor uses the same). */
export const MNEMONIC_MAX = 200;

/** KANJIDIC marks okurigana with '.' and affix use with '-': 'た.べる', '-び'. */
function splitReading(r: string): { stem: string; okurigana: string; spoken: string } {
  const clean = r.replace(/-/g, '');
  const [stem, okurigana = ''] = clean.split('.');
  return { stem: r.startsWith('-') ? `〜${stem}` : stem, okurigana: r.endsWith('-') ? `${okurigana}〜` : okurigana, spoken: stem + okurigana };
}

/** The reading to play for "Listen": the first kun reading, else the first on. */
export function spokenReading(kun: readonly string[], on: readonly string[]): string {
  return kun.length ? splitReading(kun[0]).spoken : on[0] ?? '';
}

/** One line of readings, in kana only (romaji lives in the kana chart). */
export function ReadingRow({ label, readings }: { label: string; readings: readonly string[] }) {
  if (!readings.length) return null;
  return (
    <div className="kd-reading">
      <dt>{label}</dt>
      <dd>
        {readings.map((r) => {
          const { stem, okurigana } = splitReading(r);
          return (
            <span key={r} className="kd-reading-item">
              <span lang="ja" className="kd-kana">{stem}{okurigana && <span className="kd-okurigana">{okurigana}</span>}</span>
            </span>
          );
        })}
      </dd>
    </div>
  );
}

export function MemoryHook({ item, stock }: { item?: ItemRecord; stock?: MnemonicEntry }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const text = item?.customMnemonic ?? stock?.meaning;
  const input = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);

  // The button pressed is replaced by the editor and back: keep focus with the hook.
  useEffect(() => {
    if (editing) input.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  // After Save the editor stays until the live item shows the new hook. Closing
  // earlier would briefly show "Write your own memory hook" for a first hook,
  // and focus would be lost when the Edit button replaced it.
  const [saved, setSaved] = useState<{ value: string | undefined } | null>(null);
  useEffect(() => {
    if (saved && (!item || item.customMnemonic === saved.value)) {
      setSaved(null);
      setEditing(false);
    }
  }, [saved, item]);

  if (item?.hideMnemonic) {
    return (
      <button type="button" className="btn ghost small kd-show-hook" onClick={() => void db.items.update(item.id, { hideMnemonic: false })}>
        <Icon name="bulb" size={18} />Show memory hook
      </button>
    );
  }
  if (!text && !editing) {
    // Only learned items have a record to keep a hook in.
    return item ? (
      <button ref={editButton} type="button" className="btn ghost small kd-show-hook" onClick={() => { setDraft(''); setEditing(true); }}>
        <Icon name="plus" size={18} />Write your own memory hook
      </button>
    ) : null;
  }

  const save = async () => {
    if (!item) return;
    const value = draft.trim() || undefined;
    await db.items.update(item.id, { customMnemonic: value });
    setSaved({ value });
  };

  return (
    <section className="kd-hook" aria-labelledby="kd-hook-title">
      <p id="kd-hook-title" className="kd-hook-label"><Icon name="bulb" size={16} />Memory hook</p>
      {editing ? (
        <>
          <label className="visually-hidden" htmlFor="kd-hook-input">Your memory hook</label>
          <textarea ref={input} id="kd-hook-input" className="kd-hook-input" rows={3} maxLength={MNEMONIC_MAX} value={draft}
            placeholder="One short picture that ties the shape to the meaning" onChange={(e) => setDraft(e.target.value)} />
          <div className="kd-hook-actions">
            <button type="button" className="btn primary small" onClick={() => void save()}>Save</button>
            <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
            {item?.customMnemonic && stock && (
              <button type="button" className="btn ghost small"
                onClick={() => { void db.items.update(item.id, { customMnemonic: undefined }); setEditing(false); }}>
                Use the original
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="kd-hook-text">{text}</p>
          {stock?.sound && !item?.customMnemonic && <p className="kd-hook-sound"><span className="kd-hook-sound-label">Sound:</span> {stock.sound}</p>}
          {item && (
            <div className="kd-hook-actions">
              <button ref={editButton} type="button" className="btn ghost small"
                onClick={() => { setDraft(text ?? ''); setEditing(true); }}>Edit</button>
              <button type="button" className="btn ghost small" onClick={() => void db.items.update(item.id, { hideMnemonic: true })}>Hide</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function whenDue(due: Date, now: Date): string {
  if (due.getTime() <= now.getTime()) return 'Due now';
  const days = daysBetween(dayKey(now), dayKey(due));
  if (days <= 0) return 'Later today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days · ${DAY.format(due)}`;
}

/** `justLearned`: focus moves here (the control the learner used is gone). */
export function CardStatus({ item, cards, justLearned = false }: {
  item: ItemRecord;
  cards: readonly CardRecord[];
  justLearned?: boolean;
}) {
  const section = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (justLearned && focusLost()) section.current?.focus();
  }, [justLearned]);
  const active = cards.filter((c) => !c.suspended);
  const next = active.reduce<Date | undefined>((min, c) => (!min || c.due < min ? c.due : min), undefined);
  const lapses = cards.reduce((sum, c) => sum + c.lapses, 0);
  const retired = cards.some((c) => c.type === 'write' && c.suspended === 'retired');
  return (
    <section ref={section} className="card kd-status" aria-label="Your progress" tabIndex={justLearned ? -1 : undefined}>
      <div>
        {/* The day it was introduced: "learned" is 3 spaced successes, which this date isn't. */}
        <span className="kd-stat-label">First met</span>
        <span className="kd-stat">{DAY.format(item.introducedAt)}</span>
      </div>
      <div>
        <span className="kd-stat-label">Next review</span>
        <span className="kd-stat">{next ? whenDue(next, new Date()) : 'Not scheduled'}</span>
      </div>
      <div>
        <span className="kd-stat-label">{retired ? 'Handwriting' : 'Forgotten'}</span>
        <span className="kd-stat">
          {retired ? 'Reading only' : lapses === 0 ? 'Never' : lapses === 1 ? 'Once' : `${lapses} times`}
        </span>
      </div>
    </section>
  );
}

/** "Keep in handwriting": a pinned kanji keeps its write card beyond the handwriting list. */
export function PinToggle({ item }: { item: ItemRecord }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const toggle = async (pinned: boolean) => {
    setBusy(true);
    setProblem(false);
    try {
      await setPinned(item.key, pinned);
    } catch {
      setProblem(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card kd-pin">
      <Switch label="Keep in handwriting"
        hint="Its write card stays even past your handwriting list in Settings."
        checked={Boolean(item.pinned)} disabled={busy} onChange={(v) => void toggle(v)} />
      {problem && <p className="hm-error" role="alert">Couldn't change that. Try again.</p>}
    </div>
  );
}
