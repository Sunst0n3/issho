// Settings: You, Study, Kana and Appearance sections.
import { useId, useState, type ReactNode } from 'react';
import { loadKana } from '../../lib/data.ts';
import { getSettings, updateSettings } from '../../lib/db.ts';
import type { KanaScript, Settings } from '../../lib/types.ts';
import { applyKnownKana } from '../../srs/course.ts';
import { speak, ttsAvailable, useJapaneseVoices } from '../../speech/tts.ts';
import { isPairedSettings } from '../../sync/client.ts';
import { Icon } from '../ui.tsx';
import { Segmented, Switch } from './controls.tsx';
import { minutesForPace } from './labels.ts';
import { syncMemberName } from './nameSync.ts';
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

function RangeRow({ label, hint, min, max, step, value, format, onChange }: {
  label: string;
  hint: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="set-row set-range">
      <div className="set-range-head">
        <label className="hm-field-label" htmlFor={id}>{label}</label>
        <output htmlFor={id} className="set-value">{format(value)}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        aria-valuetext={format(value)} aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(Number(e.target.value))} />
      <p id={`${id}-hint`} className="hm-hint">{hint}</p>
    </div>
  );
}

function retentionHint(r: number): string {
  if (r >= 0.93) return "You'll remember more, but expect noticeably more reviews each day.";
  if (r <= 0.87) return "Fewer reviews, but you'll forget a little more between them.";
  return 'How sure you want to be of an answer when it comes back. 90% is a good balance.';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function VoicePicker({ settings }: { settings: Settings }) {
  const voices = useJapaneseVoices();
  const labels = voices.map((v) => voiceLabel(v.name));
  // Two voices that shorten to the same name keep their full names.
  const labelOf = (v: SpeechSynthesisVoice, i: number) =>
    labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]) ? labels[i] : v.name;
  const [testing, setTesting] = useState(false);
  if (!ttsAvailable()) {
    return <p className="hm-hint set-row">This browser can't speak Japanese, so audio stays off.</p>;
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
      <label className="hm-field-label" htmlFor="set-voice">Japanese voice</label>
      <div className="set-inline">
        <select id="set-voice" className="set-select" value={settings.ttsVoice ?? ''}
          onChange={(e) => void updateSettings({ ttsVoice: e.target.value || undefined })}>
          <option value="">Best available</option>
          {voices.map((v, i) => <option key={v.voiceURI} value={v.voiceURI}>{labelOf(v, i)}</option>)}
        </select>
        <button type="button" className="btn secondary small" onClick={() => void test()} disabled={testing}>
          <Icon name="speaker" size={16} />{testing ? 'Playing' : 'Test'}
        </button>
      </div>
      {voices.length === 0 && (
        <p className="hm-hint">
          No Japanese voice found yet. On iPhone, add one in Settings → Accessibility → Spoken Content → Voices → Japanese.
        </p>
      )}
    </div>
  );
}

export function StudySection({ settings }: { settings: Settings }) {
  const [newPerDay, setNewPerDay] = useDraft(settings.newPerDay, (v: number) => updateSettings({ newPerDay: v }));
  const [maxReviews, setMaxReviews] = useDraft(settings.maxReviewsPerDay, (v: number) => updateSettings({ maxReviewsPerDay: v }));
  const [retention, setRetention] = useDraft(settings.desiredRetention, (v: number) => updateSettings({ desiredRetention: v }));

  return (
    <SettingsSection id="set-study" title="Study">
      <div className="set-row">
        <div className="set-range-head">
          <span className="hm-field-label" id="set-new-label">New items per day</span>
          <div className="set-stepper" role="group" aria-labelledby="set-new-label">
            <button type="button" className="icon-btn outlined" aria-label="Fewer new items"
              disabled={newPerDay <= 1} onClick={() => setNewPerDay(clamp(newPerDay - 1, 1, 15))}>
              <span aria-hidden="true" className="set-step-sign">−</span>
            </button>
            <output className="set-value" aria-live="polite">{newPerDay}</output>
            <button type="button" className="icon-btn outlined" aria-label="More new items"
              disabled={newPerDay >= 15} onClick={() => setNewPerDay(clamp(newPerDay + 1, 1, 15))}>
              <Icon name="plus" size={18} />
            </button>
          </div>
        </div>
        <p className="hm-hint">About {minutesForPace(newPerDay)} minutes a day once reviews build up.</p>
      </div>

      <RangeRow label="Most reviews per day" min={50} max={300} step={10} value={maxReviews}
        format={(v) => String(v)} onChange={setMaxReviews}
        hint="Anything over this waits for the next day. New items pause if a big backlog builds up." />

      <RangeRow label="How much to remember" min={0.85} max={0.95} step={0.01} value={retention}
        format={(v) => `${Math.round(v * 100)}%`} onChange={setRetention} hint={retentionHint(retention)} />

      <div className="set-row hm-field">
        <span className="hm-field-label">Readings over kanji (furigana)</span>
        <Segmented label="Readings over kanji" value={settings.furigana}
          onChange={(furigana) => void updateSettings({ furigana })}
          options={[
            { value: 'always', label: 'Always' },
            { value: 'unknown', label: 'New kanji' },
            { value: 'never', label: 'Never' },
          ]} />
        <p className="hm-hint">“New kanji” shows readings only for kanji you haven't learned yet.</p>
      </div>

      <div className="set-row">
        <Switch label="Show romaji" hint="Latin letters under kana while you're learning them."
          checked={settings.romaji} onChange={(romaji) => void updateSettings({ romaji })} />
      </div>
      <div className="set-row">
        <Switch label="Play audio automatically" hint="Hear words and sentences as they appear."
          checked={settings.audio} onChange={(audio) => void updateSettings({ audio })} />
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
    </SettingsSection>
  );
}

export function KanaSection({ settings }: { settings: Settings }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const change = async (script: KanaScript, on: boolean) => {
    setBusy(true);
    setMessage(undefined);
    try {
      await updateSettings(script === 'hiragana' ? { knowsHiragana: on } : { knowsKatakana: on });
      if (on) {
        await applyKnownKana();
        // applyKnownKana covers every known script; the message is about the one just turned on.
        const count = (await loadKana()).filter((k) => k.script === script).length;
        setMessage({ ok: true, text: `Done: ${count} ${script} are now in your reviews as known.` });
      } else {
        setMessage({ ok: true, text: "Kana you've already learned stay in your reviews." });
      }
    } catch {
      setMessage({ ok: false, text: "Couldn't update your kana. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="set-kana" title="Kana">
      <div className="set-row">
        <Switch label="I already know hiragana" hint="Skips the hiragana lessons." disabled={busy}
          checked={settings.knowsHiragana} onChange={(v) => void change('hiragana', v)} />
      </div>
      <div className="set-row">
        <Switch label="I already know katakana" hint="Skips the katakana lessons." disabled={busy}
          checked={settings.knowsKatakana} onChange={(v) => void change('katakana', v)} />
      </div>
      {message && <p className={message.ok ? 'hm-ok' : 'hm-error'} role="status">{message.text}</p>}
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
