// Settings: backup, restore and reset (Data), and About.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { version } from '../../../package.json';
import { BackupError, backupFileName, exportBackup, importBackup, type BackupImport } from '../../lib/backup.ts';
import { db, getSettings } from '../../lib/db.ts';
import { applyKnownKana } from '../../srs/course.ts';
import { resetSentencesShown } from '../../srs/planner.ts';
import { pushStats } from '../../sync/stats.ts';
import { SettingsSection } from './SettingsStudy.tsx';
import { plural } from './labels.ts';

type Message = { ok: boolean; text: string };

/**
 * Deletes every learned item, card, review and day on this phone, and the list
 * of reading sentences shown lately. Settings, the home-server pairing and chat
 * stay. Kana the learner said they already know are marked known again, as
 * onboarding did.
 */
export async function resetProgress(): Promise<void> {
  await db.transaction('rw', [db.items, db.cards, db.reviewLogs, db.days, db.savedSentences], async () => {
    await Promise.all([db.items.clear(), db.cards.clear(), db.reviewLogs.clear(), db.days.clear(), db.savedSentences.clear()]);
  });
  resetSentencesShown();
  const s = await getSettings();
  if (s.knowsHiragana || s.knowsKatakana) await applyKnownKana();
  void pushStats({ immediate: true });
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking straight away can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

export function DataSection() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>();
  const [restore, setRestore] = useState<BackupImport>();
  const [resetOpen, setResetOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const resetWord = useRef<HTMLInputElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const restoreTitle = useRef<HTMLParagraphElement>(null);
  const wasResetOpen = useRef(false);

  // The reset button is replaced by its confirmation: focus moves to the field
  // to type in, and back to the button when the confirmation closes.
  useEffect(() => {
    if (resetOpen) resetWord.current?.focus();
    else if (wasResetOpen.current) resetButton.current?.focus();
    wasResetOpen.current = resetOpen;
  }, [resetOpen]);

  // A checked backup asks for confirmation: take focus there.
  useEffect(() => {
    if (restore) restoreTitle.current?.focus();
  }, [restore]);

  const run = async (work: () => Promise<Message>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage(await work());
    } catch (e) {
      setMessage({ ok: false, text: e instanceof BackupError ? e.message : 'Something went wrong. Nothing was changed.' });
    } finally {
      setBusy(false);
    }
  };

  const onExport = () => run(async () => {
    const name = backupFileName();
    download(await exportBackup(), name);
    return { ok: true, text: `Saved ${name}. Keep it somewhere safe, like Files or iCloud Drive.` };
  });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so choosing the same file again still fires a change
    if (!file) return;
    setResetOpen(false);
    void run(async () => {
      setRestore(await importBackup(file));
      return { ok: true, text: 'Backup checked. Confirm below to restore it.' };
    });
  };

  const onRestore = (backup: BackupImport) => run(async () => {
    await backup.apply();
    setRestore(undefined);
    return { ok: true, text: 'Backup restored.' };
  });

  const onReset = () => run(async () => {
    await resetProgress();
    setResetOpen(false);
    setTyped('');
    return { ok: true, text: 'All progress was reset. Today starts fresh.' };
  });

  const confirmed = typed.trim().toLowerCase() === 'reset';

  return (
    <SettingsSection id="set-data" title="Data">
      <div className="set-row">
        <p className="hm-hint">
          Your progress lives only on this phone. Save a backup now and then, or before changing phones.
        </p>
        <div className="set-buttons">
          <button type="button" className="btn secondary small" onClick={() => void onExport()} disabled={busy}>
            Export backup
          </button>
          <button type="button" className="btn secondary small" onClick={() => fileInput.current?.click()} disabled={busy}>
            Import backup…
          </button>
          <input ref={fileInput} type="file" accept=".json,application/json" className="visually-hidden"
            tabIndex={-1} aria-label="Backup file" onChange={onFile} />
        </div>
      </div>

      {restore && (
        <div className="set-row set-confirm" role="group" aria-labelledby="set-restore-title">
          <p id="set-restore-title" ref={restoreTitle} tabIndex={-1} className="hm-field-label set-confirm-title">
            Restore the backup from {DATE.format(restore.exportedAt)}?
          </p>
          <p className="hm-hint">
            This replaces all progress on this phone with the backup
            ({plural(restore.counts.items ?? 0, 'item')}, {plural(restore.counts.reviewLogs ?? 0, 'review')}).
            Your home server connection stays as it is.
          </p>
          <div className="set-confirm-actions">
            <button type="button" className="btn primary small" onClick={() => void onRestore(restore)} disabled={busy}>
              Replace my progress
            </button>
            <button type="button" className="btn secondary small" onClick={() => { setRestore(undefined); setMessage(undefined); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="set-row">
        {resetOpen ? (
          <div className="set-confirm" role="group" aria-labelledby="set-reset-title">
            <p id="set-reset-title" className="hm-field-label">Reset all progress?</p>
            <p className="hm-hint">
              This deletes everything you've learned on this phone, with its reviews and streak. It can't be undone,
              so export a backup first if you might want it back.
            </p>
            <div className="hm-field">
              <label className="hm-field-label" htmlFor="set-reset-word">Type “reset” to confirm</label>
              <input ref={resetWord} id="set-reset-word" className="text-input" value={typed} autoComplete="off" autoCapitalize="none"
                autoCorrect="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
            </div>
            <div className="set-confirm-actions">
              <button type="button" className="btn primary small" onClick={() => void onReset()} disabled={!confirmed || busy}>
                Delete all progress
              </button>
              <button type="button" className="btn secondary small" onClick={() => { setResetOpen(false); setTyped(''); }} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button ref={resetButton} type="button" className="btn secondary small set-danger"
            onClick={() => { setRestore(undefined); setMessage(undefined); setResetOpen(true); }}>
            Reset all progress
          </button>
        )}
      </div>

      {message && <p className={message.ok ? 'hm-ok' : 'hm-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
    </SettingsSection>
  );
}

export function AboutSection() {
  const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;
  return (
    <SettingsSection id="set-about" title="About">
      <div className="set-row">
        <p><strong>Issho</strong> <span className="muted">version {version}</span></p>
        <p className="hm-hint">
          Built on what research says works: test yourself before you see the answer, with reviews spaced to come back
          just before you'd forget (FSRS).
        </p>
        <p className="hm-hint">
          Write every character by hand, learn parts before whole kanji, meet kanji inside real words, and use it together.
        </p>
      </div>
      <div className="set-row">
        <p className="hm-field-label">Credits</p>
        <ul className="set-credits">
          <li>
            <p>Stroke order: KanjiVG © Ulrich Apel, CC BY-SA 3.0</p>
            <p className="set-credit-links">
              <a href="https://kanjivg.tagaini.net/" {...ext}>KanjiVG</a>
              <a href="https://creativecommons.org/licenses/by-sa/3.0/" {...ext}>CC BY-SA 3.0</a>
            </p>
          </li>
          <li>
            <p>Kanji and words: KANJIDIC2 and JMdict © EDRDG, CC BY-SA 4.0</p>
            <p className="set-credit-links">
              <a href="https://www.edrdg.org/wiki/index.php/KANJIDIC_Project" {...ext}>KANJIDIC2</a>
              <a href="https://www.edrdg.org/jmdict/j_jmdict.html" {...ext}>JMdict</a>
              <a href="https://www.edrdg.org/" {...ext}>EDRDG</a>
              <a href="https://creativecommons.org/licenses/by-sa/4.0/" {...ext}>CC BY-SA 4.0</a>
            </p>
          </li>
          <li><p>Fonts: Shippori Mincho and Zen Kaku Gothic New, SIL Open Font License</p></li>
        </ul>
      </div>
    </SettingsSection>
  );
}
