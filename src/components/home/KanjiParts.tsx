// Pieces of the kanji page: readings, memory hook, the learner's card status.
import { useState } from 'react';
import { dayKey, db, itemId } from '../../lib/db.ts';
import type { CardRecord, CurriculumUnit, ItemRecord } from '../../lib/types.ts';
import { introducePlanItem } from '../../srs/course.ts';
import { daysBetween } from '../../srs/days.ts';
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
      <button type="button" className="btn ghost small kd-show-hook" onClick={() => { setDraft(''); setEditing(true); }}>
        <Icon name="plus" size={18} />Write your own memory hook
      </button>
    ) : null;
  }

  const save = async () => {
    if (!item) return;
    await db.items.update(item.id, { customMnemonic: draft.trim() || undefined });
    setEditing(false);
  };

  return (
    <section className="kd-hook" aria-labelledby="kd-hook-title">
      <p id="kd-hook-title" className="kd-hook-label"><Icon name="bulb" size={16} />Memory hook</p>
      {editing ? (
        <>
          <label className="visually-hidden" htmlFor="kd-hook-input">Your memory hook</label>
          <textarea id="kd-hook-input" className="kd-hook-input" rows={3} maxLength={200} value={draft}
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
              <button type="button" className="btn ghost small" onClick={() => { setDraft(text ?? ''); setEditing(true); }}>Edit</button>
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

export function CardStatus({ item, cards }: { item: ItemRecord; cards: readonly CardRecord[] }) {
  const active = cards.filter((c) => !c.suspended);
  const next = active.reduce<Date | undefined>((min, c) => (!min || c.due < min ? c.due : min), undefined);
  const lapses = active.reduce((sum, c) => sum + c.lapses, 0);
  return (
    <section className="card kd-status" aria-label="Your progress">
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

export function ComingUp({ unit, nextUp }: { unit: CurriculumUnit; nextUp: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const learn = async () => {
    setBusy(true);
    setError(false);
    try {
      await introducePlanItem({
        itemId: itemId(unit.type, unit.char),
        kind: unit.type,
        key: unit.char,
        ...(unit.type === 'kanji' ? { words: unit.words } : {}),
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
