// Today's sitting. The learner picks where they are (anywhere, at a desk, or all of it); the day is planned again
// from progress for what is left, and the sitting runs its steps: warm-up → (teach, memory) per batch → read & listen
// → first check → today's sentence → fluency → summary. Reopening re-plans, so stopping part-way loses nothing.
// Short sessions from Today (?mode=micro|welcome|makeup) skip the choice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadStudyDisplay, StudyDisplayProvider } from '../components/study/DisplayProvider.tsx';
import type { StudyDisplay } from '../components/study/display.ts';
import { useFocusHeading, useScrollToTop } from '../components/study/focus.ts';
import { FluencySprint } from '../components/study/FluencySprint.tsx';
import { youCanNow } from '../components/study/learn/data.ts';
import { MemoryPass, SPACED_RECALL_LINE } from '../components/study/learn/MemoryPass.tsx';
import { NewItemFlow } from '../components/study/learn/NewItemFlow.tsx';
import { markOutputResultsSeen, OutputResults, unseenOutputResults } from '../components/study/OutputResults.tsx';
import { OutputStep } from '../components/study/OutputStep.tsx';
import { ReadBlock } from '../components/study/ReadBlock.tsx';
import { ReviewBlock, type BlockProgress } from '../components/study/ReviewBlock.tsx';
import {
  canRetrieve,
  firstCheckIds,
  initialSession,
  sessionReducer,
  sessionSteps,
  sittingTaught,
  stepLabel,
  type LearnedItem,
  type SessionEvent,
  type SessionState,
  type SessionStep,
} from '../components/study/session/machine.ts';
import { SessionHeader, StopDialog } from '../components/study/SessionChrome.tsx';
import { SessionEmpty, SessionSummary, type EmptyReason, type SummaryData } from '../components/study/SessionSummary.tsx';
import { useStudyTimer, type StudyTimeKind } from '../components/study/time.ts';
import { Icon, Screen } from '../components/ui.tsx';
import { loadKanaRules } from '../lib/data.ts';
import { dayKey, db, getSettings } from '../lib/db.ts';
import type { KanaRule, OutputSentenceRecord } from '../lib/types.ts';
import { currentUnit } from '../srs/course.ts';
import { weekStart } from '../srs/days.ts';
import { completeDay, completeMakeup, completeMicro, streak, type StreakV2 } from '../srs/habits.ts';
import { finishStep, planMakeup, planMicro, planToday, startSitting, type DayPlan, type Sitting } from '../srs/planner.ts';
import { learnedToday, retention } from '../srs/progress.ts';
import { packsFor, prefetchPacks, setDefaultAudioRate } from '../speech/audio.ts';
import { pushStats, useHousehold } from '../sync/stats.ts';
import '../components/study/study.css';

type ShortMode = 'micro' | 'welcome' | 'makeup';

const NO_PROGRESS: BlockProgress = { done: 0, position: 1, total: 0, reask: false };

/**
 * History state of the extra entry the session adds on top of its own, so the
 * back gesture lands on the session (which asks before stopping) instead of
 * leaving it.
 */
const BACK_GUARD = 'issho.sessionGuard';
/** The ISO week whose retention card was last shown on this device (the first sitting of each week shows it). */
const RETENTION_WEEK_KEY = 'issho.retention.week';
const KANJI_PER_CHAPTER = 15;

/** Plans whose finished steps complete the day (goal met). */
const FULL_MODES: ReadonlySet<DayPlan['mode']> = new Set(['sprint', 'normal', 'catch-up', 'travel']);

const SITTINGS: { sitting: Sitting; label: string; note: string }[] = [
  { sitting: 'any', label: 'All of it', note: 'Everything planned for today' },
  { sitting: 'desk', label: 'At my desk', note: 'Lessons, reading, the first check and your sentence' },
  { sitting: 'anywhere', label: 'Anywhere (no pen)', note: 'Reviews only, handwriting with a finger' },
];

/** How time in a step is booked: reading, output and fluency count against the strand reserve. */
function timeKindOf(step: SessionStep | undefined, mode: DayPlan['mode']): StudyTimeKind {
  if (mode === 'makeup') return 'makeup';
  return step && (step.id === 'read' || step.id === 'output' || step.id === 'fluency') ? 'strand' : 'lesson';
}

function shortModeOf(search: string): ShortMode | null {
  const mode = new URLSearchParams(search).get('mode');
  return mode === 'micro' || mode === 'welcome' || mode === 'makeup' ? mode : null;
}

function planFor(mode: ShortMode | null, sitting: Sitting, extraKanji: boolean): Promise<DayPlan> {
  const now = new Date();
  if (mode === 'micro') return planMicro(now);
  if (mode === 'welcome') return planMicro(now, { welcomeBack: true });
  if (mode === 'makeup') return planMakeup(now);
  return planToday(now, { sitting, ...(extraKanji ? { extraKanji: true } : {}) });
}

/**
 * A short session (micro, welcome-back, make-up) on a catch-up day shows no card count either (§3.2.1 item 5): whether
 * today is a catch-up day comes from the day record (an earlier catch-up sitting) or from today's full plan (read-only).
 */
async function catchUpDay(mode: ShortMode | null, plan: DayPlan): Promise<boolean> {
  if (plan.mode === 'catch-up' || plan.counts === undefined) return true;
  if (!mode) return false;
  try {
    if ((await db.days.get(dayKey()))?.catchUp) return true;
    return mode !== 'makeup' && (await planToday(new Date()))?.mode === 'catch-up';
  } catch (e) {
    console.warn('could not tell whether today is a catch-up day', e);
    return false;
  }
}

/**
 * Why an empty sitting is empty. A phone-only sitting holds only the reviews: when today's lessons, reading or first
 * check are still to do, they need a desk sitting, and the summary must not say they are done.
 */
async function emptyReason(mode: ShortMode | null, plan: DayPlan): Promise<EmptyReason> {
  if (mode) return 'short';
  if (plan.sitting !== 'anywhere' || sessionSteps(plan).length > 1) return 'done';
  try {
    const full = await planToday(new Date(), { sitting: 'any' });
    return full && sessionSteps(full).some((s) => s.id !== 'warmup' && s.id !== 'summary') ? 'desk' : 'done';
  } catch (e) {
    console.warn('could not plan the rest of today', e);
    return 'done';
  }
}

/** The first sitting of this ISO week on this device shows the retention card; later ones don't. */
function firstSittingOfWeek(): boolean {
  const week = weekStart(dayKey());
  try {
    if (localStorage.getItem(RETENTION_WEEK_KEY) === week) return false;
    localStorage.setItem(RETENTION_WEEK_KEY, week);
  } catch {
    // Storage blocked: show it; the card is harmless to repeat.
  }
  return true;
}

async function summaryData(plan: DayPlan, learned: readonly LearnedItem[], streakNow: StreakV2 | undefined): Promise<SummaryData> {
  const [day, todayIds] = await Promise.all([db.days.get(dayKey()), learnedToday().catch(() => [] as string[])]);
  const ids = todayIds.length ? todayIds : learned.flatMap((l) => l.itemIds);
  const kanaWords = plan.read?.kind === 'kana-words' ? plan.read.kanaWords.map((w) => w.kana) : [];
  const [canNow, stats] = await Promise.all([
    youCanNow(ids, kanaWords).catch(() => undefined),
    firstSittingOfWeek() ? retention().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return {
    ...(canNow ? { canNow } : {}),
    minutesToday: Math.max(day?.studyMs ? 1 : 0, Math.round((day?.studyMs ?? 0) / 60_000)),
    tomorrowMin: plan.tomorrowMin,
    ...(stats ? { retention: stats } : {}),
    ...(streakNow ? { streak: streakNow } : {}),
  };
}

function SittingChoice({ busy, onChoose, onClose }: { busy: boolean; onChoose: (s: Sitting) => void; onClose: () => void }) {
  // Opened again by "Choose another sitting", whose button is gone: focus goes to the question, not the page.
  const root = useRef<HTMLElement>(null);
  useFocusHeading(root, 'sittings');
  return (
    <Screen label="Today's session">
      <SessionHeader progress={0} label="" onClose={onClose} />
      <section ref={root} className="st-sittings" aria-labelledby="st-sitting-title" aria-busy={busy || undefined}>
        <h1 id="st-sitting-title" className="st-summary-title">Where are you?</h1>
        <p className="muted">Each sitting plans what is left of today.</p>
        <div className="st-links">
          {SITTINGS.map((s) => (
            <button key={s.sitting} type="button" className={s.sitting === 'any' ? 'card st-link st-sitting default' : 'card st-link st-sitting'}
              // aria-disabled, not disabled, while planning: the chosen button keeps keyboard focus.
              aria-disabled={busy || undefined} onClick={() => { if (!busy) onChoose(s.sitting); }}>
              <span><strong>{s.label}</strong><span className="muted">{s.note}</span></span>
              <Icon name="forward" size={18} />
            </button>
          ))}
        </div>
      </section>
    </Screen>
  );
}

interface Loaded {
  plan: DayPlan;
  display: StudyDisplay;
  /** Kana rule lessons: the kana each one teaches, for the romaji helper during the sitting. */
  rules: KanaRule[];
  /** What the empty screen says when the sitting has nothing to do. */
  empty: EmptyReason;
  /** Checks of earlier sentences that came back after they were sent: shown once, before the first step. */
  results: OutputSentenceRecord[];
}

/**
 * Each opening is its own session: a new mode from Today, or the summary's make-up offer (same route, another
 * search), gets a fresh plan, timer and start-up guard instead of the finished session's state.
 */
export default function Session() {
  const { search } = useLocation();
  /** "Choose a sitting" on an empty phone-only sitting: a fresh opening with the sitting choice. */
  const [run, setRun] = useState(0);
  return <SessionRun key={`${search}#${run}`} onRestart={() => setRun((r) => r + 1)} />;
}

function SessionRun({ onRestart }: { onRestart: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const shortMode = shortModeOf(location.search);
  const extraKanji = new URLSearchParams(location.search).get('extra') === '1';
  const timer = useStudyTimer(shortMode === 'makeup' ? 'makeup' : 'lesson');
  const household = useHousehold();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [planning, setPlanning] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [state, setState] = useState<SessionState | null>(null);
  const [blockProgress, setBlockProgress] = useState(NO_PROGRESS);
  const [summary, setSummary] = useState<SummaryData>();
  /** The item on screen in a teach batch (0-based), for the romaji helper. */
  const [lessonAt, setLessonAt] = useState(0);
  /** Why "Stop for now?" is open: the close button, or the back gesture. */
  const [confirming, setConfirming] = useState<false | 'close' | 'back'>(false);
  /** Day-0 retrievals, mirrored synchronously so a re-ask can be checked against the cap at once. */
  const retrievals = useRef<Record<string, number>>({});
  const started = useRef(false);
  const completion = useRef<Promise<void> | null>(null);
  /** The step index last left: a second "done" from the same step (a late callback) is ignored. */
  const advancedFrom = useRef(-1);

  const dispatch = useCallback((e: SessionEvent) => setState((s) => (s ? sessionReducer(s, e) : s)), []);

  // ---- Planning: once per opening (StrictMode and double taps included) ----
  const start = useCallback(async (sitting: Sitting) => {
    if (started.current) return;
    started.current = true;
    setPlanning(true);
    setLoadError(false);
    try {
      const planned = await planFor(shortMode, sitting, extraKanji);
      await startSitting(planned);
      const [settings, display, results, rules, catchUp, empty] = await Promise.all([
        getSettings(),
        loadStudyDisplay(),
        unseenOutputResults().catch((e: unknown) => {
          console.warn('could not load checked sentences', e);
          return [];
        }),
        loadKanaRules().catch((e: unknown) => {
          console.warn('could not load the kana rules', e);
          return [] as KanaRule[];
        }),
        catchUpDay(shortMode, planned),
        emptyReason(shortMode, planned),
      ]);
      // During catch-up no card count shows anywhere: the header and the block read a plan without counts.
      const plan: DayPlan = catchUp ? { ...planned, counts: undefined } : planned;
      setDefaultAudioRate(plan.courseDay, settings.audioRate);
      setLoaded({ plan, display, results, rules, empty });
      setState(initialSession(plan));
    } catch (e) {
      console.error('could not plan the session', e);
      started.current = false;
      setLoadError(true);
    } finally {
      setPlanning(false);
    }
  }, [shortMode, extraKanji]);

  useEffect(() => {
    if (shortMode) void start('any');
  }, [shortMode, start]);

  const plan = loaded?.plan;
  const step = state ? state.steps[state.index] : undefined;
  // Kana taught earlier in this sitting (and the one whose lesson is on screen) lose their romaji at once (§3.2.3).
  const lessonItem = step?.id === 'teach' && step.batch !== undefined ? plan?.teach[step.batch]?.items[lessonAt] : undefined;
  const learnedNow = state?.learned;
  const display = useMemo<StudyDisplay | undefined>(() => {
    if (!loaded) return undefined;
    const taught = sittingTaught(loaded.display.taught, learnedNow ?? [], lessonItem, loaded.rules);
    return taught === loaded.display.taught ? loaded.display : { ...loaded.display, taught };
  }, [loaded, learnedNow, lessonItem]);
  // The checked sentences' screen comes before the first step: leaving it starts that step at the top too.
  useScrollToTop(state ? `${state.index}:${loaded?.results.length ? 'results' : 'steps'}` : 'choice');

  // ---- Step changes: book the time, record once-a-day steps, set up the check ----
  const leaveStep = useCallback((s: SessionStep | undefined) => {
    if (!plan || !s) return;
    if ((s.id === 'read' || s.id === 'output' || s.id === 'fluency') && plan.mode !== 'makeup') {
      void finishStep(s.id).catch((e: unknown) => console.error('could not record the step', e));
    }
  }, [plan]);

  const next = useCallback(() => {
    if (!state || !plan || advancedFrom.current === state.index) return;
    advancedFrom.current = state.index;
    leaveStep(step);
    const upcoming = state.steps[state.index + 1];
    void timer.setKind(timeKindOf(upcoming, plan.mode));
    setBlockProgress(NO_PROGRESS);
    setLessonAt(0);
    dispatch({ type: 'next' });
  }, [state, plan, step, leaveStep, timer, dispatch]);

  useEffect(() => {
    if (plan && step) void timer.setKind(timeKindOf(step, plan.mode));
  }, [plan, step, timer]);

  useEffect(() => {
    if (!state || !plan || step?.id !== 'check' || state.checkIds) return;
    const ids = firstCheckIds(state.learned, plan.pendingCheck, Math.random);
    if (ids.length) dispatch({ type: 'start-check', ids });
    else next();
  }, [state, plan, step, dispatch, next]);

  const retrieved = useCallback((cardId: string) => {
    if (!canRetrieve({ retrievals: retrievals.current }, cardId)) return;
    retrievals.current = { ...retrievals.current, [cardId]: (retrievals.current[cardId] ?? 0) + 1 };
    dispatch({ type: 'retrieved', cardId });
  }, [dispatch]);
  const mayRetrieve = useCallback((cardId: string) => canRetrieve({ retrievals: retrievals.current }, cardId), []);

  // ---- The summary: complete the day once, then stats and what to show ----
  useEffect(() => {
    if (!plan || !state || step?.id !== 'summary' || completion.current) return;
    completion.current = (async () => {
      await timer.flush();
      let after: StreakV2 | undefined;
      try {
        if (plan.mode === 'makeup') await completeMakeup();
        else if (plan.mode === 'micro' || plan.mode === 'welcome-back') await completeMicro();
        else if (plan.sitting !== 'anywhere' && FULL_MODES.has(plan.mode)) after = await completeDay();
        after ??= await streak();
      } catch (e) {
        console.error('could not complete the session', e);
      }
      void pushStats({ immediate: true });
      setSummary(await summaryData(plan, state.learned, after).catch(() => ({ minutesToday: 0 })));
      // Keep the next days' audio close at hand.
      void (async () => {
        const [unit, kanji] = await Promise.all([currentUnit(), db.items.where('kind').equals('kanji').count()]);
        await prefetchPacks(packsFor({ sprint: loaded!.display.inSprint, unit, chapter: Math.floor(kanji / KANJI_PER_CHAPTER) + 1 }));
      })().catch((e: unknown) => console.warn('could not prefetch audio', e));
    })();
  }, [plan, state, step, timer, loaded]);

  // ---- The back gesture asks before stopping, like the close button ----
  const inSession = Boolean(state && state.steps.length > 1);
  const guarded = (location.state as Record<string, unknown> | null)?.[BACK_GUARD] === true;
  /** The guard entry is on top of the session's own. */
  const armed = useRef(false);
  const arming = useRef(false);
  /** Leaving (for Today, or the make-up): the guard entry is being taken off first. */
  const leavingTo = useRef<string | null>(null);

  /**
   * To Today (or `to`), replacing the session's history entry so back from there
   * doesn't land in the stopped session. The guard entry on top goes first
   * (back); the effect below then replaces the session's own entry.
   */
  const exit = (to = '/') => {
    if (armed.current) {
      leavingTo.current = to;
      navigate(-1);
      return;
    }
    navigate(to, { replace: true });
  };

  /** Stopping keeps what was done: the next sitting re-plans from it. */
  const leave = () => {
    void timer.flush();
    void pushStats();
    exit();
  };

  const finish = (to?: string) => {
    void Promise.resolve(completion.current).then(() => pushStats({ immediate: true }));
    exit(to);
  };

  const latest = useRef({ step, finish, navigate });
  latest.current = { step, finish, navigate };
  const arm = useCallback(() => {
    arming.current = true;
    navigate(location.pathname + location.search, { state: { [BACK_GUARD]: true } });
  }, [navigate, location.pathname, location.search]);

  useEffect(() => {
    if (!inSession) return;
    if (guarded) {
      armed.current = true;
      arming.current = false;
      return;
    }
    if (arming.current) return;
    if (!armed.current) {
      arm();
      return;
    }
    // The guard entry was popped: the session is leaving, or back was pressed.
    armed.current = false;
    if (leavingTo.current) latest.current.navigate(leavingTo.current, { replace: true });
    else if (latest.current.step?.id === 'summary') latest.current.finish();
    else setConfirming('back');
  }, [inSession, guarded, arm]);

  if (loadError) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={0} label="" onClose={() => navigate('/')} title="Today's session" />
        <div className="card st-error" role="alert">
          <p>Today's session couldn't load. If this is the first time on this phone, connect to the internet once so the lessons can download.</p>
          <button type="button" className="btn ink" onClick={() => (shortMode ? void start('any') : setLoadError(false))}>Try again</button>
        </div>
      </Screen>
    );
  }
  if (!shortMode && !loaded) {
    return <SittingChoice busy={planning} onChoose={(s) => void start(s)} onClose={() => navigate('/')} />;
  }
  if (!loaded || !state || !plan || !step) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={0} label="" onClose={() => navigate('/')} title="Today's session" />
        <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Planning today's session" />
      </Screen>
    );
  }
  if (loaded.results.length) {
    const results = loaded.results;
    return (
      <StudyDisplayProvider value={display ?? loaded.display}>
        <Screen label="Today's session">
          <SessionHeader progress={0} label="" title="Today's session" onClose={() => setConfirming('close')} />
          <OutputResults results={results}
            onDone={() => {
              void markOutputResultsSeen(results.map((r) => r.id)).catch((e: unknown) => console.warn('could not mark the checks seen', e));
              setLoaded({ ...loaded, results: [] });
            }} />
          {confirming && (
            <StopDialog onStop={leave} onKeepGoing={() => {
              if (confirming === 'back') arm();
              setConfirming(false);
            }} />
          )}
        </Screen>
      </StudyDisplayProvider>
    );
  }

  if (state.steps.length === 1) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={1} label="" onClose={() => navigate('/')} />
        <SessionEmpty reason={loaded.empty} onChooseSitting={onRestart} />
      </Screen>
    );
  }

  // ---- Header: step names; during catch-up never a card count, only a time bar ----
  const catchUp = plan.mode === 'catch-up' || plan.counts === undefined;
  const blockFraction = blockProgress.total ? Math.min(1, blockProgress.done / blockProgress.total) : 0;
  const timeFraction = Math.min(1, timer.elapsed() / Math.max(60_000, plan.estimateMin * 60_000));
  const progress = catchUp
    ? (step.id === 'summary' ? 1 : timeFraction)
    : (state.index + (step.id === 'warmup' || step.id === 'check' ? blockFraction : 0)) / Math.max(1, state.steps.length - 1);
  let label = stepLabel(step, plan);
  if (catchUp && step.id !== 'summary') label = 'Catching up';
  else if ((step.id === 'warmup' || step.id === 'check') && blockProgress.total) label = `${label} ${Math.min(blockProgress.position, blockProgress.total)} / ${blockProgress.total}`;

  const keepGoing = () => {
    // Back from the dialog put the guard entry away; put it back for next time.
    if (confirming === 'back') arm();
    setConfirming(false);
  };

  const partner = household.data?.members.find((m) => m.member.id !== household.data?.me)?.member.name ?? '';
  const batch = step.batch !== undefined ? plan.teach[step.batch] : undefined;
  const batchIds = new Set(batch?.items.map((i) => i.itemId) ?? []);
  const todayReadCards = new Set(state.learned.filter((l) => l.plan.kind === 'kana').map((l) => `${l.plan.itemId}|read`));

  return (
    <StudyDisplayProvider value={display ?? loaded.display}>
      <Screen label="Today's session">
        <SessionHeader progress={progress} label={label} title={step.id === 'summary' ? undefined : "Today's session"}
          onClose={() => (step.id === 'summary' ? finish() : setConfirming('close'))} />

        {step.id === 'warmup' && (
          <ReviewBlock key="warmup" cardIds={plan.warmup} timer={timer} context="review" hideCounts={catchUp}
            makeup={plan.mode === 'makeup'} paperAllowed={plan.paperAllowed} onProgress={setBlockProgress} onDone={next} />
        )}
        {step.id === 'teach' && batch && (
          <NewItemFlow key={`teach-${step.batch}`} batch={batch} onTaught={(item) => dispatch({ type: 'taught', item })}
            onProgress={setLessonAt} onDone={next} />
        )}
        {step.id === 'memory' && (
          <MemoryPass key={`memory-${step.batch}`} items={state.learned.filter((l) => batchIds.has(l.plan.itemId))}
            onRetrieved={retrieved} mayRetrieve={mayRetrieve} onDone={next} />
        )}
        {step.id === 'read' && plan.read && (
          <ReadBlock key="read" plan={plan.read} todayReadCards={todayReadCards} onRetrieved={retrieved} mayRetrieve={mayRetrieve} onDone={next} />
        )}
        {step.id === 'check' && state.checkIds && (
          <>
            {blockProgress.done === 0 && <p className="st-intro">{SPACED_RECALL_LINE}</p>}
            <ReviewBlock key="check" cardIds={state.checkIds} timer={timer} context="first-check" hideCounts={catchUp}
              paperAllowed={plan.paperAllowed} onProgress={setBlockProgress} onRetrieved={retrieved} mayRetrieve={mayRetrieve} onDone={next} />
          </>
        )}
        {step.id === 'output' && plan.output && (
          <OutputStep key="output" target={plan.output.target} partnerName={partner} onDone={next} />
        )}
        {step.id === 'fluency' && plan.fluency && <FluencySprint key="fluency" plan={plan.fluency} onDone={next} />}
        {step.id === 'summary' && (
          <SessionSummary data={summary} onDone={() => finish()} onMakeup={() => finish('/session?mode=makeup')} />
        )}

        {confirming && <StopDialog onKeepGoing={keepGoing} onStop={leave} />}
      </Screen>
    </StudyDisplayProvider>
  );
}
