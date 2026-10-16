import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Switch } from '../components/home/controls.tsx';
import { HabitStep } from '../components/home/HabitStep.tsx';
import { DEFAULT_MINUTES } from '../components/home/labels.ts';
import { PlacementCheck, placementText, withdrawPlacement, type PlacementResult } from '../components/home/PlacementCheck.tsx';
import {
  completeSlots,
  cueDraft,
  cueFromDraft,
  cueProblem,
  goalFromDraft,
  MinutesOptions,
  type CueDraft,
  type CueProblem,
  type GoalDraft,
} from '../components/home/planControls.tsx';
import { reminderSeed, RemindersStep } from '../components/home/RemindersStep.tsx';
import { TogetherStep } from '../components/home/TogetherStep.tsx';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { Icon, ProgressBar, Screen, type IconName } from '../components/ui.tsx';
import { requestPersistentStorage } from '../lib/backup.ts';
import { dayKey, getSettings, updateSettings } from '../lib/db.ts';
import type { DailyMinutes, KanaScript, Settings, TogetherSlot } from '../lib/types.ts';
import { planReviewDays } from '../srs/habits.ts';
import { getTogether, isPairedSettings } from '../sync/client.ts';
import { postTogetherEvent, useTogetherState } from '../sync/together.ts';
import '../components/home/home.css';
import '../components/home/settings.css';

type Step = 'welcome' | 'name' | 'minutes' | 'kana' | 'habit' | 'together' | 'reminders' | 'connect';
const STEPS: Step[] = ['welcome', 'name', 'minutes', 'kana', 'habit', 'together', 'reminders', 'connect'];
const SCRIPTS: KanaScript[] = ['hiragana', 'katakana'];

/**
 * Each step is its own history entry (/welcome?step=kana), so the phone's back
 * gesture goes to the previous step like the on-screen Back, and a reload stays
 * on the step. `depth` counts the steps pushed since onboarding opened.
 */
interface StepState {
  onboardingDepth: number;
  /** The step this entry was pushed from. */
  from: Step;
}

const stepSearch = (step: Step) => (step === 'welcome' ? '' : `?step=${step}`);

function stepOf(search: string): Step {
  const step = new URLSearchParams(search).get('step') as Step | null;
  return step && STEPS.includes(step) ? step : 'welcome';
}

function stepState(state: unknown): StepState | undefined {
  const s = state as Partial<StepState> | null;
  return s && typeof s.onboardingDepth === 'number' && s.from ? (s as StepState) : undefined;
}

const METHOD: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'eye', title: 'Recall, then check', text: 'Every card asks first and shows the answer after. Recalling is what makes it stick.' },
  { icon: 'pen', title: 'Write by hand', text: 'Write each kana and kanji from memory. Your phone checks the whole character.' },
  { icon: 'people', title: 'Use it together', text: 'Three short sessions a week: quiz each other, act out real tasks, talk about a story.' },
];

function StepFrame({ hero, title, lead, children, footer }: {
  hero?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to each new step's heading so screen readers announce it.
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <>
      <div className="onboard-body">
        {hero}
        <h1 ref={heading} tabIndex={-1} className="onboard-title">{title}</h1>
        {lead && <p className="onboard-lead">{lead}</p>}
        {children}
      </div>
      {footer && <div className="onboard-foot">{footer}</div>}
    </>
  );
}

type KanaPhase = { kind: 'ask' } | { kind: 'check'; script: KanaScript; queue: KanaScript[] };

export default function Onboarding() {
  const navigate = useNavigate();
  const location = useLocation();
  const step = stepOf(location.search);
  const entry = stepState(location.state);
  const depth = entry?.onboardingDepth ?? 0;
  const [saved, setSaved] = useState<Settings>();
  const [done, setDone] = useState(false);
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState<DailyMinutes>(DEFAULT_MINUTES);
  const [knows, setKnows] = useState<Record<KanaScript, boolean>>({ hiragana: false, katakana: false });
  const [kanaPhase, setKanaPhase] = useState<KanaPhase>({ kind: 'ask' });
  const [placement, setPlacement] = useState<Partial<Record<KanaScript, PlacementResult>>>({});
  const [cue, setCue] = useState<CueDraft>(cueDraft(undefined));
  /** Continue found the cue half filled (it would be dropped): shown until it is fixed. */
  const [cueIssue, setCueIssue] = useState<CueProblem>();
  const [coping, setCoping] = useState('');
  const [slots, setSlots] = useState<TogetherSlot[]>(completeSlots(undefined));
  /** The slots shown are the household's (set earlier by either member, or by this phone before). */
  const [slotsFromHousehold, setSlotsFromHousehold] = useState(false);
  const [goal, setGoal] = useState<GoalDraft>({ text: '', targetDate: '' });
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string>();
  const finished = useRef(false);
  const finishAfterKana = useRef(false);
  const edited = useRef(false);
  /** The together slots were posted to the household during the together step. */
  const posted = useRef(false);
  const together = useTogetherState();
  const today = dayKey();

  // Coming back to onboarding starts from what's saved, unless they've already started answering.
  useEffect(() => {
    let live = true;
    void getSettings().then((s) => {
      if (!live) return;
      setSaved(s);
      if (edited.current) return;
      setName(s.name);
      setMinutes(s.dailyMinutes);
      setKnows({ hiragana: s.knowsHiragana, katakana: s.knowsKatakana });
      setCue(cueDraft(s.cue));
      setCoping(s.coping ?? '');
      if (s.togetherSlots.length) setSlots(completeSlots(s.togetherSlots));
      if (s.sharedGoal) setGoal(s.sharedGoal);
    });
    return () => { live = false; };
  }, []);

  // A paired phone (kept through the v2 upgrade) starts from the household's slots and goal.
  const household = together.state;
  useEffect(() => {
    if (!household || edited.current || !saved || saved.togetherSlots.length) return;
    if (household.slots.length) {
      setSlots(completeSlots(household.slots));
      setSlotsFromHousehold(true);
    }
    if (household.goal && !saved.sharedGoal) setGoal(household.goal);
  }, [household, saved]);

  // A placement check belongs to the kana step: leaving the step (Back, or the back gesture) ends it, so
  // coming back shows the question and its switches again.
  useEffect(() => {
    if (step !== 'kana') setKanaPhase({ kind: 'ask' });
  }, [step]);

  const index = STEPS.indexOf(step);
  const go = (to: Step) => {
    edited.current = true;
    setError(undefined);
    navigate({ search: stepSearch(to) }, { state: { onboardingDepth: depth + 1, from: step } satisfies StepState });
  };
  const back = () => {
    const previous = STEPS[Math.max(0, index - 1)];
    setError(undefined);
    // Same as the system back gesture when the previous entry is the previous step.
    if (entry?.from === previous) navigate(-1);
    else navigate({ search: stepSearch(previous) }, { replace: true, state: location.state });
  };

  /** Saves this step's answers, then moves on. */
  const saveAndGo = async (patch: Partial<Omit<Settings, 'id'>>, next: Step, after?: (s: Settings) => Promise<void>) => {
    try {
      const s = await updateSettings(patch);
      setSaved(s);
      await after?.(s);
      go(next);
    } catch {
      setError("Couldn't save that on this phone. Try again.");
    }
  };

  const postSlots = async (s: Settings) => {
    if (!isPairedSettings(s)) return;
    await postTogetherEvent({ type: 'slots', slots: s.togetherSlots });
    if (s.sharedGoal) await postTogetherEvent({ type: 'goal', goal: s.sharedGoal });
    posted.current = true;
  };

  /**
   * Paired at the last step: share this phone's slots and goal with the household, unless the
   * partner set them first (then this phone takes theirs). Offline, they stay in Settings.
   */
  const shareWithHousehold = async (s: Settings) => {
    if (posted.current || !isPairedSettings(s)) return;
    try {
      const state = await getTogether();
      if (state.slots.length) await updateSettings({ togetherSlots: state.slots, ...(state.goal ? { sharedGoal: state.goal } : {}) });
      else await postSlots(s);
      if (state.slots.length && !state.goal && s.sharedGoal) await postTogetherEvent({ type: 'goal', goal: s.sharedGoal });
    } catch {
      // The household is out of reach: Settings → Together can share them later.
    }
  };

  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    setFinishing(true);
    setError(undefined);
    try {
      const s = await updateSettings({ name: name.trim(), planReviewDays: planReviewDays(dayKey()), onboarded: true,
        togetherSlots: saved?.togetherSlots.length ? saved.togetherSlots : completeSlots(slots) });
      void shareWithHousehold(s);
      void requestPersistentStorage();
      setDone(true);
      // Rendering one redirect below also handles Back into an old setup entry.
      // Do not race the browser's asynchronous history.go() against the app gate.
    } catch {
      finished.current = false;
      setFinishing(false);
      setError("Couldn't finish setting up. Check that the app has finished downloading, then try again.");
    }
  };

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void saveAndGo({ name: name.trim() }, 'minutes');
  };

  /** A script whose check this phone already passed (an earlier run of onboarding). */
  const passedBefore = (script: KanaScript) =>
    Boolean(script === 'hiragana' ? saved?.knowsHiragana : saved?.knowsKatakana);
  /** The check for the script was passed (now or before), whatever its switch says. */
  const passed = (script: KanaScript) => placement[script]?.outcome === 'known' || passedBefore(script);
  /** The script is switched on and its check passed: the sprint skips it. */
  const knownNow = (script: KanaScript) => knows[script] && passed(script);
  const otherOf = (script: KanaScript) => SCRIPTS.find((s) => s !== script)!;
  /** The other script is known: a failed check means its 7-day sprint only. */
  const otherKnown = (script: KanaScript) => knownNow(otherOf(script));
  /** A status line already says how the script goes (its check was taken, or passed before). */
  const settled = (script: KanaScript) => knows[script] && (placement[script] !== undefined || passedBefore(script));

  const startKanaChecks = async (quick = false) => {
    finishAfterKana.current = quick;
    edited.current = true;
    setError(undefined);
    // Switched off after its check passed: the pass is undone, so the sprint teaches the script.
    const withdrawn = SCRIPTS.filter((s) => !knows[s] && passed(s));
    if (withdrawn.length) {
      try {
        for (const script of withdrawn) setSaved(await withdrawPlacement(script));
      } catch {
        setError("Couldn't save that on this phone. Try again.");
        return;
      }
      setPlacement((p) => Object.fromEntries(Object.entries(p).filter(([s]) => !withdrawn.includes(s as KanaScript))));
    }
    const queue = SCRIPTS.filter((s) => knows[s] && !placement[s] && !passedBefore(s));
    if (!queue.length) { if (quick) await finish(); else go('habit'); }
    else setKanaPhase({ kind: 'check', script: queue[0], queue: queue.slice(1) });
  };

  /** The line under the switches about the sprint, for the scripts no status line covers yet. */
  const sprintHint = (): string | undefined => {
    const open = SCRIPTS.filter((s) => !settled(s));
    if (open.length === SCRIPTS.length) return 'Not sure? Leave them off. The kana sprint takes about two weeks.';
    if (!open.length) return undefined;
    const [script] = open;
    return knownNow(otherOf(script))
      ? `Not sure about ${script}? Leave it off. Its sprint takes about a week.`
      : `Not sure about ${script}? Leave it off. The kana sprint takes about two weeks.`;
  };

  const nextCheck = (queue: KanaScript[]) => {
    if (queue.length) setKanaPhase({ kind: 'check', script: queue[0], queue: queue.slice(1) });
    else {
      setKanaPhase({ kind: 'ask' });
      if (finishAfterKana.current) void finish(); else go('habit');
    }
  };

  if (done || saved?.onboarded) return <Navigate to="/" replace />;
  // Later steps need the name (pairing uses it): a reload or link there without one starts at the name.
  if (saved && !done && index > STEPS.indexOf('name') && !name.trim()) {
    return <Navigate to={{ search: stepSearch('name') }} replace />;
  }

  const savedCue = cueFromDraft(cue);
  const slotsToSave = completeSlots(slots);

  let body: ReactNode;
  switch (step) {
    case 'welcome':
      body = (
        <StepFrame
          hero={<span className="welcome-seal" lang="ja" aria-hidden="true">一緒</span>}
          title="Japanese, together"
          lead={<>Issho (<span lang="ja">一緒</span>) means “together”. A set time each day, side by side. Here's how it works:</>}
          footer={<button type="button" className="btn primary block" onClick={() => go('name')}>Get started</button>}
        >
          <ul className="welcome-method">
            {METHOD.map((m) => (
              <li key={m.title}>
                <span className="welcome-method-icon" aria-hidden="true"><Icon name={m.icon} size={20} /></span>
                <div><strong>{m.title}</strong><p>{m.text}</p></div>
              </li>
            ))}
          </ul>
        </StepFrame>
      );
      break;

    case 'name':
      body = (
        <form className="onboard-form" onSubmit={submitName}>
          <StepFrame
            title="What should we call you?"
            footer={<button type="submit" className="btn primary block" disabled={!name.trim()}>Continue</button>}
          >
            <div className="hm-field">
              <label className="hm-field-label" htmlFor="onboard-name">Your name</label>
              <input id="onboard-name" className="text-input" value={name} maxLength={40} autoComplete="given-name"
                onChange={(e) => setName(e.target.value)} aria-describedby="onboard-name-hint" />
              <span id="onboard-name-hint" className="hm-hint">Your partner sees this when you study together.</span>
            </div>
          </StepFrame>
        </form>
      );
      break;

    case 'minutes':
      body = (
        <StepFrame
          title="How long each day?"
          lead="Pick a daily time. Issho fills it with reviews, new things and reading, and keeps you close to it."
          footer={<button type="button" className="btn primary block" onClick={() => void saveAndGo({ dailyMinutes: minutes }, 'kana')}>Continue</button>}
        >
          <MinutesOptions value={minutes} onChange={(m) => { edited.current = true; setMinutes(m); }} legend="Minutes each day" />
          <p className="hm-hint">Your pace follows your reviews and study time. You can change the time any day in Settings.</p>
        </StepFrame>
      );
      break;

    case 'kana':
      if (kanaPhase.kind === 'check') {
        body = (
          <StepFrame title={`Check your ${kanaPhase.script}`}>
            <PlacementCheck key={kanaPhase.script} script={kanaPhase.script}
              otherKnown={otherKnown(kanaPhase.script)}
              onDone={(r) => {
                setPlacement((p) => ({ ...p, [r.script]: r }));
                nextCheck(kanaPhase.queue);
              }}
              onCancel={() => nextCheck(kanaPhase.queue)} />
          </StepFrame>
        );
        break;
      }
      body = (
        <StepFrame
          title="Do you already know kana?"
          lead="Hiragana and katakana are the two Japanese alphabets. If you know one, a quick check lets you skip its lessons."
          footer={<>
            <button type="button" className="btn primary block" onClick={() => void startKanaChecks(true)} disabled={finishing}>Start learning</button>
            <button type="button" className="btn ghost block" onClick={() => void startKanaChecks()} disabled={finishing}>Set up my routine first</button>
          </>}
        >
          <div className="card onboard-switches">
            <Switch label={<>I know hiragana <span className="hm-kana-sample" lang="ja">あいう</span></>}
              checked={knows.hiragana} onChange={(v) => { edited.current = true; setKnows((k) => ({ ...k, hiragana: v })); }} />
            <Switch label={<>I know katakana <span className="hm-kana-sample" lang="ja">アイウ</span></>}
              checked={knows.katakana} onChange={(v) => { edited.current = true; setKnows((k) => ({ ...k, katakana: v })); }} />
          </div>
          {SCRIPTS.filter((s) => knows[s] && placement[s]).map((s) => (
            <p key={s} className="hm-ok" role="status">
              {placementText(placement[s]!, otherKnown(s))}
            </p>
          ))}
          {SCRIPTS.filter((s) => knows[s] && !placement[s] && passedBefore(s)).map((s) => (
            <p key={s} className="hm-ok" role="status">You're past {s} already.</p>
          ))}
          {SCRIPTS.filter((s) => !knows[s] && passed(s)).map((s) => (
            <p key={s} className="hm-hint" role="status">Switched off: the sprint teaches {s} from the start.</p>
          ))}
          {sprintHint() && <p className="hm-hint">{sprintHint()}</p>}
          <p className="hm-hint">Habits, reminders and partner connection can wait until after your first lesson. Find them in Settings and Together.</p>
        </StepFrame>
      );
      break;

    case 'habit':
      body = (
        <StepFrame
          title="When will you study?"
          lead="Pick a moment you already have every day, and what you'll do on a busy one."
          footer={
            <button type="button" className="btn primary block"
              onClick={() => {
                // A half-filled cue would be dropped without a word: ask for what's missing instead.
                const problem = cueProblem(cue);
                setCueIssue(problem);
                if (!problem) void saveAndGo({ cue: savedCue, coping: coping.trim() || undefined }, 'together');
              }}>
              Continue
            </button>
          }
        >
          <HabitStep cue={cue} coping={coping} cueProblem={cueIssue}
            onCue={(d) => { edited.current = true; setCue(d); setCueIssue((was) => (was ? cueProblem(d) : undefined)); }}
            onCoping={(v) => { edited.current = true; setCoping(v); }} />
        </StepFrame>
      );
      break;

    case 'together':
      body = (
        <StepFrame
          title="Time together"
          lead="Three 15-minute sessions a week, each with its own job. Pick times that suit you both."
          footer={
            <button type="button" className="btn primary block"
              onClick={() => void saveAndGo({ togetherSlots: slotsToSave, sharedGoal: goalFromDraft(goal) }, 'reminders', postSlots)}>
              Continue
            </button>
          }
        >
          <TogetherStep slots={slotsToSave} goal={goal} today={today} fromHousehold={slotsFromHousehold}
            onSlots={(s) => { edited.current = true; setSlotsFromHousehold(false); setSlots(s); }}
            onGoal={(g) => { edited.current = true; setGoal(g); }} />
        </StepFrame>
      );
      break;

    case 'reminders':
      body = (
        <StepFrame
          title="Reminders"
          lead="Add your daily cue and your together sessions to your phone's calendar. No notifications from Issho, no nagging."
          footer={<button type="button" className="btn primary block" onClick={() => go('connect')}>Continue</button>}
        >
          <RemindersStep cue={savedCue} slots={slotsToSave}
            input={{ cue: savedCue, slots: slotsToSave, start: today, name: name.trim(), uidSeed: reminderSeed(saved?.memberId) }} />
        </StepFrame>
      );
      break;

    case 'connect':
      // A phone that kept its pairing through the upgrade is already connected.
      body = saved && isPairedSettings(saved) ? (
        <StepFrame
          title="Study together"
          lead={`This phone is still connected to ${saved.householdName ?? 'your home server'}. Your chat and your partner are where you left them.`}
          footer={
            <button type="button" className="btn primary block" onClick={() => void finish()} disabled={finishing}>
              {finishing ? 'Getting things ready…' : 'Start learning'}
            </button>
          }
        />
      ) : (
        <StepFrame
          title="Study together"
          lead="A small server at home lets you two see each other's progress, chat in Japanese and run your sessions together. Everything else works without it."
        >
          {finishing
            ? <p className="muted" role="status">Getting things ready…</p>
            : <ConnectServerForm onConnected={() => void finish()} onSkip={() => void finish()} />}
        </StepFrame>
      );
      break;
  }

  return (
    <Screen label="Welcome to Issho">
      <div className="onboard-top">
        {index > 0
          ? <button type="button" className="icon-btn" aria-label="Back" onClick={back} disabled={finishing}><Icon name="back" size={22} /></button>
          : <span className="onboard-spacer" aria-hidden="true" />}
        <ProgressBar value={index < 4 ? (index + 1) / 4 : (index - 3) / 4} label="Setup progress" />
        <span className="onboard-step">{index < 4 ? `Step ${index + 1} of 4` : `Optional setup ${index - 3} of 4`}</span>
      </div>
      {error && <p className="hm-error" role="alert">{error}</p>}
      {/* Until the saved answers are read, a tap could move on without them (and lose the saved name). */}
      {saved
        ? <div key={step} className="onboard-step-body">{body}</div>
        : <div className="hm-skeleton card-sized" aria-busy="true" aria-label="Loading your setup" />}
    </Screen>
  );
}
