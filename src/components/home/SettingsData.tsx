// Settings: backup, restore and reset (Data), and About.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { version } from '../../../package.json';
import type { BackupSnapshot } from '../../../shared/api.ts';
import { BackupError, backupFileName, exportBackup, importBackup, type BackupImport } from '../../lib/backup.ts';
import { loadAudioManifest } from '../../lib/data.ts';
import { dayKey, db, getSettings, updateSettings, type IsshoDB } from '../../lib/db.ts';
import type { KanaScript } from '../../lib/types.ts';
import { applyPlacement, PLACEMENT_ITEMS } from '../../srs/course.ts';
import { planReviewDays } from '../../srs/habits.ts';
import { pushStats } from '../../sync/stats.ts';
import { requestServerBackup } from '../../sync/backups.ts';
import { getServerBackup, isPairedSettings, listBackups, pairingOwner, samePairingOwner } from '../../sync/client.ts';
import { useLive } from './useLive.ts';
import { SettingsSection } from './SettingsStudy.tsx';
import { plural } from './labels.ts';

type Message = { ok: boolean; text: string };

/** A checked backup waiting for confirmation, with what this phone has now (a v1 file deletes it). */
interface PendingRestore {
  backup: BackupImport;
  /** Items and reviews on this phone now. */
  here: { items: number; reviewLogs: number };
}

/** Every table of learning progress. Settings, chat (messages, outbox) and queued together events stay. */
export const RESET_TABLES = [
  'items', 'cards', 'reviewLogs', 'days', 'savedSentences', 'encounters', 'shownSentences', 'staged', 'stories',
  'restTokens', 'outputs', 'canDos', 'milestones', 'pitchBoxes', 'fluency', 'partnerQuizzes', 'togetherPlans',
] as const satisfies readonly (keyof IsshoDB & string)[];

/**
 * Deletes everything learned on this phone: items, cards, reviews, days, reading and story progress,
 * rest tokens, sentences, can-dos, milestones, pitch and fluency records, partner quizzes and the cached
 * together plans. Settings, the home-server pairing, chat and queued together events stay. A script the
 * learner passed the placement check for starts as known again, as it did after onboarding.
 */
export async function resetProgress(now: Date = new Date()): Promise<void> {
  const tables = RESET_TABLES.map((name) => db.table(name));
  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((t) => t.clear()));
  });
  // Settings that belong to the old progress: a fresh start chosen for it, travel mode (its days are gone,
  // and day 1 must teach), and the plan reviews counted from its first day (weeks 4 and 8 of the new course).
  const s = await updateSettings({ freshStart: undefined, travelUntil: undefined, planReviewDays: planReviewDays(dayKey(now)) });
  const known: KanaScript[] = [
    ...(s.knowsHiragana ? ['hiragana' as const] : []),
    ...(s.knowsKatakana ? ['katakana' as const] : []),
  ];
  for (const script of known) await applyPlacement(script, PLACEMENT_ITEMS);
  void pushStats({ immediate: true });
}

/** Read when the audio manifest has none (not generated yet). */
export const VOICE_CREDITS_FALLBACK = ['VOICEVOX:No.7', 'VOICEVOX:青山龍星'];

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

/** This phone has learning progress a restore would delete. */
const hasProgress = (here: PendingRestore['here']) => here.items > 0 || here.reviewLogs > 0;

function restoreLabel({ backup, here }: PendingRestore): string {
  if (!backup.progressDropped) return 'Replace my progress';
  return hasProgress(here) ? 'Delete my progress and restore' : 'Restore settings and chat';
}

/**
 * A v1 backup: only its settings and chat come back, and restoring still clears this phone's progress and
 * sends the learner through setup again (its settings are the earlier course's). Said plainly before the tap,
 * since the app goes straight to setup afterwards.
 */
function V1RestoreNotice({ here }: { here: PendingRestore['here'] }) {
  return (
    <>
      <p className="hm-hint">
        This backup is from the earlier version of Issho. Its settings and chat come back, but its learning
        progress can't carry over to the new course.
      </p>
      {hasProgress(here) && (
        <p className="hm-error">
          Restoring it deletes all progress on this phone ({plural(here.items, 'item')},{' '}
          {plural(here.reviewLogs, 'review')}), and it can't be undone. Export a backup first if you might want it back.
        </p>
      )}
      <p className="hm-hint">Afterwards Issho takes you through setup again. Your home server connection stays as it is.</p>
    </>
  );
}

export function DataSection() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>();
  const [restore, setRestore] = useState<PendingRestore>();
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>();
  const backupSettings = useLive(getSettings, []);
  const settings = backupSettings.status === 'ready' ? backupSettings.value : undefined;
  const paired = settings && isPairedSettings(settings);
  const ownBackup = settings && samePairingOwner(settings.serverBackupOwner, pairingOwner(settings));
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
      const backup = await importBackup(file);
      const [items, reviewLogs] = await Promise.all([db.items.count(), db.reviewLogs.count()]);
      setRestore({ backup, here: { items, reviewLogs } });
      return { ok: true, text: 'Backup checked. Confirm below to restore it.' };
    });
  };

  const onServerRestore = (id: string) => run(async () => {
    const backup = await importBackup(await getServerBackup(id));
    const [items, reviewLogs] = await Promise.all([db.items.count(), db.reviewLogs.count()]);
    setRestore({ backup, here: { items, reviewLogs } });
    setResetOpen(false);
    return { ok: true, text: 'Server backup checked. Confirm below to restore it.' };
  });

  const onRestore = (backup: BackupImport) => run(async () => {
    await backup.apply();
    setRestore(undefined);
    return {
      ok: true,
      text: backup.progressDropped
        ? "Settings and chat restored. The backup's progress was from the earlier course, so it wasn't brought over."
        : 'Backup restored.',
    };
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
          Progress is saved on this phone. When connected, completed sessions also back up to your home server, which keeps your fourteen latest snapshots. Keep a manual copy before changing phones.
        </p>
        <p className="hm-hint" role="status">
          {ownBackup && settings?.serverBackupCompletedAt
            ? `Last server backup: ${new Date(settings.serverBackupCompletedAt).toLocaleString()}.`
            : 'No server backup confirmed on this phone yet.'}
          {settings?.serverBackupPending && ' A backup is waiting for your home server.'}
        </p>
        {paired && <>
          <div className="set-buttons">
            <button type="button" className="btn secondary small" disabled={busy} onClick={() => void run(async () => {
              await requestServerBackup();
              return (await getSettings()).serverBackupPending
                ? { ok: false, text: 'Backup is waiting. Check that your home server is running and up to date. Manual export is available below.' }
                : { ok: true, text: 'Progress backed up to your home server.' };
            })}>Back up to server now</button>
            <button type="button" className="btn secondary small" disabled={busy} onClick={() => void run(async () => {
              const found = await listBackups(); setSnapshots(found);
              return { ok: true, text: found.length ? 'Choose a snapshot to check before restoring.' : 'No server snapshots yet. Back up this phone first.' };
            })}>Find server backups</button>
          </div>
          {snapshots?.map((snapshot) => <p key={snapshot.id}>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void onServerRestore(snapshot.id)}>
              Restore snapshot from {new Date(snapshot.createdAt).toLocaleString()}
            </button>
          </p>)}
        </>}
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
            Restore the backup from {DATE.format(restore.backup.exportedAt)}?
          </p>
          {restore.backup.progressDropped ? (
            <V1RestoreNotice here={restore.here} />
          ) : (
            <p className="hm-hint">
              This replaces all progress on this phone with the backup
              ({plural(restore.backup.counts.items ?? 0, 'item')}, {plural(restore.backup.counts.reviewLogs ?? 0, 'review')}).
              Your home server connection stays as it is.
            </p>
          )}
          <div className="set-confirm-actions">
            <button type="button" className="btn primary small" onClick={() => void onRestore(restore.backup)} disabled={busy}>
              {restoreLabel(restore)}
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
              This deletes everything you've learned on this phone: reviews, streak, rest days, stories, can-dos and
              milestones, and ends travel mode. Settings and chat stay. It can't be undone, so export a backup first if
              you might want it back.
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

function useVoiceCredits(): string[] {
  const manifest = useLive(() => loadAudioManifest(), []);
  const credits = manifest.status === 'ready' ? manifest.value.credits : [];
  return credits.length ? credits : VOICE_CREDITS_FALLBACK;
}

export function AboutSection() {
  const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;
  const voices = useVoiceCredits();
  return (
    <SettingsSection id="set-about" title="About">
      <div className="set-row">
        <p><strong>Issho</strong> <span className="muted">version {version}</span></p>
        <p className="hm-hint">
          Built on what research says works: test yourself before you see the answer, with reviews spaced to come back
          just before you'd forget (FSRS).
        </p>
        <p className="hm-hint">
          Write every character from memory, meet kanji inside real words, read and listen every day, and use it together.
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
          <li>
            <p>Voices: {voices.join(', ')}</p>
            <p className="set-credit-links">
              <a href="https://voicevox.hiroshiba.jp/" {...ext}>VOICEVOX</a>
            </p>
          </li>
          <li><p>Fonts: Shippori Mincho and Zen Kaku Gothic New, SIL Open Font License</p></li>
        </ul>
      </div>
    </SettingsSection>
  );
}
