// Pieces of the kanji page: readings, memory hook, the learner's card status.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadWordIndex } from '../../lib/data.ts';
import { dayKey, db, itemId } from '../../lib/db.ts';
import type { CardRecord, CurriculumUnit, ItemRecord, WordEntry } from '../../lib/types.ts';
import { introducePlanItem } from '../../srs/course.ts';
import { daysBetween } from '../../srs/days.ts';
import { MNEMONIC_MAX } from '../study/learn/KanjiLesson.tsx';
import { focusLost } from '../together/focus.ts';
import { Icon } from '../ui.tsx';
import { kanaToRomaji } from './romaji.ts';

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

export function ReadingRow({ label, readings, romaji }: { label: string; readings: readonly string[]; romaji: boolean }) {
  if (!readings.length) return null;
  return (
    <div className="kd-reading">
      <dt>{label}</dt>
      <dd>
        {readings.map((r) => {
          const { stem, okurigana, spoken } = splitReading(r);
          return (
            <span key={r} className="kd-reading-item">
              <span lang="ja" className="kd-kana">{stem}{okurigana && <span className="kd-okurigana">{okurigana}</span>}</span>
              {romaji && <span className="kd-romaji">{kanaToRomaji(spoken)}</span>}
            </span>
          );
        })}
      </dd>
    </div>
  );
}

export function MemoryHook({ item, stock }: { item?: ItemRecord; stock?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const text = item?.customMnemonic ?? stock;
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

/** `justLearned`: it replaces "Learn this now", whose button had focus; focus moves here. */
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
  const lapses = active.reduce((sum, c) => sum + c.lapses, 0);
  return (
    <section ref={section} className="card kd-status" aria-label="Your progress" tabIndex={justLearned ? -1 : undefined}>
      <div>
        <span className="kd-stat-label">Learned</span>
        <span className="kd-stat">{DAY.format(item.introducedAt)}</span>
      </div>
      <div>
        <span className="kd-stat-label">Next review</span>
        <span className="kd-stat">{next ? whenDue(next, new Date()) : 'Not scheduled'}</span>
      </div>
      <div>
        <span className="kd-stat-label">Forgotten</span>
        <span className="kd-stat">{lapses === 0 ? 'Never' : lapses === 1 ? 'Once' : `${lapses} times`}</span>
      </div>
    </section>
  );
}

/**
 * The unit's words that can come along when it is learned ahead of the course:
 * only those whose other kanji are already known, as the course guarantees
 * when it reaches the unit in order.
 */
export async function readableWords(unit: CurriculumUnit): Promise<string[]> {
  if (unit.type !== 'kanji' || !unit.words.length) return [];
  const [index, known] = await Promise.all([
    // Without the word list the kanji still comes, just on its own.
    loadWordIndex().catch(() => new Map<string, WordEntry>()),
    db.items.where('kind').equals('kanji').primaryKeys(),
  ]);
  const knownKanji = new Set(known.map((id) => String(id).slice('kanji:'.length)));
  knownKanji.add(unit.char);
  return unit.words.filter((id) => {
    const word = index.get(id);
    return word !== undefined && word.kanji.every((k) => knownKanji.has(k));
  });
}

export function ComingUp({ unit, nextUp, onShow }: { unit: CurriculumUnit; nextUp: boolean; onShow?(): void }) {
  const [busy, setBusy] = useState(false);
  const shown = useRef(onShow);
  shown.current = onShow;
  useEffect(() => shown.current?.(), [unit.char]);
  const [error, setError] = useState(false);
  const learn = async () => {
    setBusy(true);
    setError(false);
    try {
      await introducePlanItem({
        itemId: itemId(unit.type, unit.char),
        kind: unit.type,
        key: unit.char,
        ...(unit.type === 'kanji' ? { words: await readableWords(unit) } : {}),
      });
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <section className="card kd-coming">
      <p>
        <strong>{nextUp ? 'Next up' : `Coming up in unit ${unit.index + 1}`}</strong>
        <span className="muted"> · Learn it now and it joins your reviews from today.</span>
      </p>
      <button type="button" className="btn secondary small" onClick={() => void learn()} disabled={busy}>
        <Icon name="plus" size={18} />{busy ? 'Adding…' : 'Learn this now'}
      </button>
      {error && <p className="hm-error" role="alert">Couldn't add it. Try again.</p>}
    </section>
  );
}
