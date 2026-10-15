// Settings: You, Study and Appearance sections.
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState, type ReactNode } from 'react';
import { loadCurriculum, loadKana } from '../../lib/data.ts';
import { db, getSettings, itemId, MAX_WRITE_LIST, RECEPTIVE_RETENTIONS, updateSettings } from '../../lib/db.ts';
import type { DailyMinutes, KanaEntry, KanaScript, Settings } from '../../lib/types.ts';
import { PLACEMENT_PASS } from '../../srs/course.ts';
import { syncWriteRetirement } from '../../srs/items.ts';
import { speak, ttsAvailable, useJapaneseVoices } from '../../speech/tts.ts';
import { isPairedSettings } from '../../sync/client.ts';
import { Icon } from '../ui.tsx';
import { Segmented, Switch } from './controls.tsx';
import { MINUTES_NOTES, percent, plural } from './labels.ts';
import { syncMemberName } from './nameSync.ts';
import { PlacementCheck, placementText, type PlacementResult, type PlacementSummary } from './PlacementCheck.tsx';
import { setTheme, storedTheme, type ThemeChoice } from './theme.ts';
import { useDraft } from './useDraft.ts';

export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="set-section" aria-labelledby={id}>
      <h2 id={id} className="hm-section-title">{title}</h2>
      <div className="card set-card">{children}</div>
    </section>
  );
}

/**
 * Saves a typed name. An empty name is never saved (onboarding requires one and
 * pairing needs it), so the last name stays until a new one is typed. A paired
 * phone also renames its member on the home server.
 */
async function saveName(value: string): Promise<void> {
  if (!value.trim()) return;
  const saved = await updateSettings({ name: value });
  if (isPairedSettings(saved)) await syncMemberName(value);
}

export function YouSection({ settings }: { settings: Settings }) {
  const [name, setName] = useDraft(settings.name, saveName, 500);
  const empty = !name.trim();
  return (
    <SettingsSection id="set-you" title="You">
      <div className="hm-field set-row">
        <label className="hm-field-label" htmlFor="set-name">Your name</label>
        <input id="set-name" className="text-input" value={name} maxLength={40} autoComplete="given-name"
          aria-invalid={empty || undefined} aria-describedby="set-name-hint"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            // Leaving the field empty puts the saved name back.
            if (empty) void getSettings().then((s) => setName(s.name));
            else if (name.trim() !== name) setName(name.trim());
          }} />
        {empty
          ? <p id="set-name-hint" className="hm-error" role="status">Add a name. Your partner sees it when you study together.</p>
          : <p id="set-name-hint" className="hm-hint">Your partner sees this when you study together.</p>}
      </div>
    </SettingsSection>
  );
}

/**
 * A shorter voice name for the picker: "Flo (Japanese (Japan))" → "Flo",
 * "Microsoft Nanami Online (Natural) - Japanese (Japan)" → "Microsoft Nanami Online (Natural)".
 */
export function voiceLabel(name: string): string {
  const short = name
    .replace(/\s*[-–]\s*(Japanese|日本語).*$/i, '')
    .replace(/\s*\((Japanese|日本語)(\s*\([^()]*\)|[^()])*\)\s*$/i, '')
    .trim();
  return short || name;
}

function VoicePicker({ settings }: { settings: Settings }) {
  const voices = useJapaneseVoices();
  const labels = voices.map((v) => voiceLabel(v.name));
  // Two voices that shorten to the same name keep their full names.
  const labelOf = (v: SpeechSynthesisVoice, i: number) =>
    labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]) ? labels[i] : v.name;
  const [testing, setTesting] = useState(false);
  if (!ttsAvailable()) {
    return <p className="hm-hint set-row">This browser has no Japanese voice of its own. Recorded audio still plays.</p>;
  }
  const test = async () => {
    setTesting(true);
    try {
      await speak('こんにちは。いっしょに べんきょう しましょう。', { voiceURI: settings.ttsVoice });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="hm-field set-row">
      <label className="hm-field-label" htmlFor="set-voice">Device voice</label>
      <div className="set-inline">
        <select id="set-voice" className="set-select" value={settings.ttsVoice ?? ''} aria-describedby="set-voice-hint"
          onChange={(e) => void updateSettings({ ttsVoice: e.target.value || undefined })}>
          <option value="">Best available</option>
          {voices.map((v, i) => <option key={v.voiceURI} value={v.voiceURI}>{labelOf(v, i)}</option>)}
        </select>
        <button type="button" className="btn secondary small" onClick={() => void test()} disabled={testing}>
          <Icon name="speaker" size={16} />{testing ? 'Playing' : 'Test'}
        </button>
      </div>
      <p id="set-voice-hint" className="hm-hint">
        Used only for text without a recording, when the home server can't speak it either.
        {voices.length === 0 && ' No Japanese voice found yet. On iPhone, add one in Settings → Accessibility → Spoken Content → Voices → Japanese.'}
      </p>
    </div>
  );
}

const RETENTION_NOTE =
  'Lower means fewer reviews of reading and listening cards, and a little more forgetting. Handwriting and production stay at 90 %.';


const WRITE_LIST_STEP = 50;
/** The slider's last stop: the whole list. */
const WRITE_LIST_STOPS = Math.ceil(MAX_WRITE_LIST / WRITE_LIST_STEP);

/**
 * pure: slider stop → handwriting list size, 50 kanji a stop. The last stop is all 2,136 (a range input
 * stepping by 50 up to 2,136 itself could only reach 2,100).
 */
export function writeListAt(stop: number): number {
  return Math.max(0, Math.min(MAX_WRITE_LIST, Math.round(stop) * WRITE_LIST_STEP));
}

/** pure: handwriting list size → the nearest slider stop. */
export function writeListStop(size: number): number {
  return Math.max(0, Math.min(WRITE_LIST_STOPS, Math.round(size / WRITE_LIST_STEP)));
}

/**
 * pure: pinned kanji beyond a handwriting list of `size` (curriculum rank above it, or not in the curriculum).
 * A pin inside the list changes nothing, so it isn't counted.
 */
export function pinnedBeyond(pinnedRanks: readonly (number | undefined)[], size: number): number {
  return pinnedRanks.filter((rank) => rank === undefined || rank > size).length;
}

/** Curriculum rank (1-based) of each pinned kanji; undefined for one outside the curriculum. */
async function pinnedRanks(): Promise<(number | undefined)[]> {
  const [pinned, curriculum] = await Promise.all([
    db.items.where('kind').equals('kanji').filter((i) => Boolean(i.pinned)).toArray(),
    loadCurriculum(),
  ]);
  const ranks = new Map(curriculum.units.map((u) => [u.char, u.index + 1]));
  return pinned.map((i) => ranks.get(i.key));
}

/** The write list: kanji ranked within it keep their handwriting card; the rest retire once solid. */
function WriteListRow({ settings }: { settings: Settings }) {
  const id = useId();
  const ranks = useLiveQuery(() => pinnedRanks().catch(() => []), []);
  const [status, setStatus] = useState<string>();
  const [value, setValue] = useDraft(settings.writeList, async (writeList: number) => {
    await updateSettings({ writeList });
    try {
      const { retired, restored } = await syncWriteRetirement();
      const parts = [];
      if (retired) parts.push(`${plural(retired, 'kanji', 'kanji')} now reading only`);
      if (restored) parts.push(`${plural(restored, 'kanji', 'kanji')} back in handwriting`);
      setStatus(parts.length ? `${parts.join(', ')}.` : undefined);
    } catch {
      setStatus("The list is saved. Cards update at your next session.");
    }
  }, 400);
  const text = (n: number) => `${n.toLocaleString()} kanji kept in handwriting`;
  const pinned = ranks ? pinnedBeyond(ranks, value) : 0;
  return (
    <div className="set-row set-range">
      <div className="set-range-head">
        <label className="hm-field-label" htmlFor={id}>Handwriting list</label>
        <output htmlFor={id} className="set-value set-value-wide">{value.toLocaleString()}</output>
      </div>
      <input id={id} type="range" min={0} max={WRITE_LIST_STOPS} step={1} value={writeListStop(value)}
        aria-valuetext={text(value)} aria-describedby={`${id}-hint`}
        onChange={(e) => setValue(writeListAt(Number(e.target.value)))} />
      <p id={`${id}-hint`} className="hm-hint">
        {text(value)}{pinned ? `, plus ${pinned.toLocaleString()} pinned` : ''}. Kanji beyond it keep their reading
        practice and stop asking for handwriting once they're solid.
      </p>
      {status && <p className="hm-ok" role="status">{status}</p>}
    </div>
  );
}

type RateChoice = 'auto' | '0.85' | '1';

function rateChoice(rate: number | undefined): RateChoice {
  if (rate === undefined) return 'auto';
  return rate < 0.95 ? '0.85' : '1';
}

/** How much of a script's basic kana the course already has (taught, or passed in a check). */
export type ScriptTaught = 'none' | 'some' | 'all';

/** pure */
export function scriptTaught(kana: readonly KanaEntry[], introduced: ReadonlySet<string>, script: KanaScript): ScriptTaught {
  const basic = kana.filter((k) => k.script === script && k.kind === 'basic');
  const n = basic.filter((k) => introduced.has(itemId('kana', k.char))).length;
  if (n === 0) return 'none';
  return n >= basic.length ? 'all' : 'some';
}

async function loadScriptTaught(script: KanaScript): Promise<ScriptTaught> {
  const [kana, ids] = await Promise.all([loadKana(), db.items.where('kind').equals('kana').primaryKeys()]);
  return scriptTaught(kana, new Set(ids.map(String)), script);
}

/**
 * pure: what a pass does, as the re-check's intro says it. Once the course has taught the script there are
 * no lessons left to skip.
 */
export function recheckPassNote(script: KanaScript, taught: ScriptTaught): string {
  if (taught === 'all') return `All your ${script} are in your course already, so this only shows how well you know them: your reviews carry on either way.`;
  if (taught === 'some') return `${PLACEMENT_PASS} or more right and the course skips the ${script} lessons still to come.`;
  return `${PLACEMENT_PASS} or more right and you skip the ${script} lessons.`;
}

/**
 * A re-check from Settings. A pass moves the script's kana into reviews (as in onboarding), and skips the
 * lessons still to come. A fail changes nothing: kana already passed or taught stay in reviews, and the
 * others are taught by the course as planned, so no sprint length is promised (the learner may be in the
 * middle of it, or past it).
 */
export function recheckSummary(r: PlacementResult, passedBefore: boolean, taught: ScriptTaught = 'none'): PlacementSummary {
  const inReviews = passedBefore || taught === 'all';
  if (r.outcome === 'known') {
    return {
      title: placementText(r, false),
      detail: inReviews
        ? `Your ${r.script} stay in your reviews.`
        : taught === 'some'
          ? `The rest of your ${r.script} move into your reviews, and the course skips their lessons.`
          : `Your ${r.script} move into your reviews, and the course skips their lessons.`,
    };
  }
  return {
    title: `${r.correct}/${r.total} — nothing changes`,
    detail: inReviews
      ? `Your ${r.script} stay in your reviews, which keep them fresh.`
      : `The course teaches and reviews ${r.script} as planned.`,
  };
}

function PlacementRow({ settings }: { settings: Settings }) {
  const known = (s: KanaScript) => (s === 'hiragana' ? settings.knowsHiragana : settings.knowsKatakana);
  // Whether the script was passed before this check (a pass sets it, so it is read at the start), and how
  // much of it the course has taught.
  const [checking, setChecking] = useState<{ script: KanaScript; passedBefore: boolean; taught: ScriptTaught }>();
  const [result, setResult] = useState<PlacementSummary>();
  if (checking) {
    const summary = (r: PlacementResult) => recheckSummary(r, checking.passedBefore, checking.taught);
    return (
      <div className="set-row">
        <PlacementCheck script={checking.script} summary={summary} passNote={recheckPassNote(checking.script, checking.taught)}
          onDone={(r) => { setResult(summary(r)); setChecking(undefined); }}
          onCancel={() => setChecking(undefined)} />
      </div>
    );
  }
  const start = async (script: KanaScript) => {
    setResult(undefined);
    const passedBefore = known(script);
    // Unreadable data only loses the finer wording: the check itself still runs.
    const taught = await loadScriptTaught(script).catch((): ScriptTaught => 'none');
    setChecking({ script, passedBefore, taught });
  };
  return (
    <div className="set-row">
      <p className="hm-field-label">Kana check</p>
      <p className="hm-hint">
        Know a script already? A 3-minute check moves its kana straight into your reviews.
        {known('hiragana') && ' Hiragana: passed.'}
        {known('katakana') && ' Katakana: passed.'}
      </p>
      <div className="set-buttons">
        <button type="button" className="btn secondary small" onClick={() => void start('hiragana')}>
          Check hiragana
        </button>
        <button type="button" className="btn secondary small" onClick={() => void start('katakana')}>
          Check katakana
        </button>
      </div>
      {result && <p className="hm-ok" role="status">{result.title}. {result.detail}</p>}
    </div>
  );
}

export function StudySection({ settings }: { settings: Settings }) {
  const [minutes, setMinutes] = useDraft<DailyMinutes>(settings.dailyMinutes, (m) => updateSettings({ dailyMinutes: m }));
  const retention = (RECEPTIVE_RETENTIONS as readonly number[]).includes(settings.receptiveRetention)
    ? settings.receptiveRetention
    : 0.9;

  return (
    <SettingsSection id="set-study" title="Study">
      <div className="set-row hm-field">
        <span className="hm-field-label" id="set-minutes-label">Minutes each day</span>
        <Segmented label="Minutes each day" value={String(minutes) as `${DailyMinutes}`}
          onChange={(v) => setMinutes(Number(v) as DailyMinutes)}
          options={[20, 25, 30, 40].map((m) => ({ value: String(m) as `${DailyMinutes}`, label: `${m} min` }))} />
        <p className="hm-hint" aria-live="polite">At {minutes} minutes: {MINUTES_NOTES[minutes]}.</p>
      </div>

      <WriteListRow settings={settings} />

      <div className="set-row hm-field">
        <span className="hm-field-label">Recall target for reading and listening</span>
        <Segmented label="Recall target for reading and listening" value={String(retention)}
          onChange={(v) => void updateSettings({ receptiveRetention: Number(v) })}
          options={RECEPTIVE_RETENTIONS.map((r) => ({ value: String(r), label: percent(r) }))} />
        <p className="hm-hint">{RETENTION_NOTE}</p>
      </div>

      <div className="set-row hm-field">
        <span className="hm-field-label">Readings over kanji (furigana)</span>
        <Segmented label="Readings over kanji" value={settings.furigana}
          onChange={(furigana) => void updateSettings({ furigana })}
          options={[
            { value: 'always', label: 'Always' },
            { value: 'unknown', label: 'Not yet solid' },
            { value: 'never', label: 'Never' },
          ]} />
        <p className="hm-hint">“Not yet solid” hides the reading of words you read reliably, so you and your partner see different readings.</p>
      </div>

      <div className="set-row">
        <Switch label="Play audio" hint="Hear words and sentences as they appear."
          checked={settings.audio} onChange={(audio) => void updateSettings({ audio })} />
      </div>
      <div className="set-row hm-field">
        <span className="hm-field-label">Audio speed</span>
        <Segmented label="Audio speed" value={rateChoice(settings.audioRate)}
          onChange={(v) => void updateSettings({ audioRate: v === 'auto' ? undefined : Number(v) })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: '0.85', label: 'Slower' },
            { value: '1', label: 'Natural' },
          ]} />
        <p className="hm-hint">Auto plays a little slower for your first three months, then at natural speed.</p>
      </div>
      <VoicePicker settings={settings} />

      <div className="set-row hm-field">
        <span className="hm-field-label">I write with</span>
        <Segmented label="I write with" value={settings.writingHand}
          onChange={(writingHand) => void updateSettings({ writingHand })}
          options={[
            { value: 'finger', label: 'Finger' },
            { value: 'stylus', label: 'Stylus' },
          ]} />
      </div>
      <div className="set-row">
        <Switch label="Hands-busy mode" hint="Typed answers offer choices instead. Answers given that way count a little less."
          checked={settings.handsBusy} onChange={(handsBusy) => void updateSettings({ handsBusy })} />
      </div>
      <div className="set-row">
        <Switch label="Show corrections straight away" hint="Your daily sentence skips the find-it-yourself step."
          checked={settings.justShowMe} onChange={(justShowMe) => void updateSettings({ justShowMe })} />
      </div>
      <PlacementRow settings={settings} />
    </SettingsSection>
  );
}

export function AppearanceSection() {
  const [theme, setChoice] = useState<ThemeChoice>(storedTheme);
  return (
    <SettingsSection id="set-appearance" title="Appearance">
      <div className="set-row hm-field">
        <span className="hm-field-label">Theme</span>
        <Segmented label="Theme" value={theme}
          onChange={(t) => { setTheme(t); setChoice(t); }}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]} />
      </div>
    </SettingsSection>
  );
}
