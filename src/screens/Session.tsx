// Today's session: reviews first, then new items (lesson + writing), a first
// check of the new cards, reading & shadowing, and a summary. The plan is
// taken once when the screen opens; only the reading sentences are picked
// again after the new items, so they can use the kanji just learned.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { State } from 'ts-fsrs';
import { useScrollToTop } from '../components/study/focus.ts';
import { learnedLabels, type LearnedLabel } from '../components/study/learn/data.ts';
import { NewItemFlow, type LearnedItem } from '../components/study/learn/NewItemFlow.tsx';
import { ReadingDrill } from '../components/study/ReadingDrill.tsx';
import { ReviewBlock, type BlockProgress } from '../components/study/ReviewBlock.tsx';
import { sentencesById, type SentenceLike } from '../components/study/sentences.ts';
import { SessionHeader, StopDialog } from '../components/study/SessionChrome.tsx';
import { SessionEmpty, SessionSummary, type SessionStats } from '../components/study/SessionSummary.tsx';
import { useStudyTimer } from '../components/study/time.ts';
import { Screen } from '../components/ui.tsx';
import { shuffle } from '../srs/answers.ts';
import { cardTypesFor } from '../srs/items.ts';
import { deferNewCards, planReading, planToday, type SessionPlan } from '../srs/planner.ts';
import { completeSession, learnedToday, type StreakInfo } from '../srs/progress.ts';
import { pushStats } from '../sync/stats.ts';
import '../components/study/study.css';

type Step = 'review' | 'learn' | 'check' | 'read' | 'summary';

interface Loaded {
  plan: SessionPlan;
  sentences: SentenceLike[];
}

const NO_PROGRESS: BlockProgress = { done: 0, position: 1, total: 0, practice: false };

/**
 * History state of the extra entry the session adds on top of its own, so the
 * back gesture lands on the session (which asks before stopping) instead of
 * leaving it.
 */
const BACK_GUARD = 'issho.sessionGuard';

/**
 * The first check, from the new items just learned: each item's own cards and
 * each new word's reading card. Left for tomorrow's reviews: a kanji's reading
 * card when it brought new words (their reading cards ask it, in the same
 * word) and the words' meaning cards (each reading card's feedback shows the
 * meaning). That keeps the check quick.
 */
export function splitFirstCheck(learned: readonly Pick<LearnedItem, 'results'>[]): { check: string[]; later: string[] } {
  const check: string[] = [];
  const later: string[] = [];
  for (const { results } of learned) {
    const [main, ...words] = results;
    const newWords = words.some((w) => w.cards.some((c) => c.state === State.New));
    for (const result of results) {
      for (const card of result.cards) {
        if (card.state !== State.New) continue;
        const askedByWords = result === main && card.kind === 'kanji' && card.type === 'reading' && newWords;
        const wordMeaning = result !== main && card.type === 'meaning';
        (askedByWords || wordMeaning ? later : check).push(card.id);
      }
    }
  }
  return { check, later };
}

/** Cards the first check will ask (see splitFirstCheck), for sizing the progress bar before they exist. */
function expectedChecks(plan: SessionPlan): number {
  return plan.newItems.reduce((n, item) => {
    const words = item.words?.length ?? 0;
    const own = cardTypesFor(item.kind, item.key).length - (item.kind === 'kanji' && words ? 1 : 0);
    return n + own + words;
  }, 0);
}

function firstStep(l: Loaded): Step | null {
  if (l.plan.reviews.length) return 'review';
  if (l.plan.newItems.length) return 'learn';
  return null;
}

export default function Session() {
  const navigate = useNavigate();
  const location = useLocation();
  const timer = useStudyTimer();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [step, setStep] = useState<Step>('review');
  /** Why "Stop for now?" is open: the close button, or the back gesture. */
  const [confirming, setConfirming] = useState<false | 'close' | 'back'>(false);

  const [reviewProgress, setReviewProgress] = useState(NO_PROGRESS);
  const [learnIndex, setLearnIndex] = useState(0);
  const [learned, setLearned] = useState<LearnedItem[]>([]);
  const [checkIds, setCheckIds] = useState<string[] | null>(null);
  const [checkProgress, setCheckProgress] = useState(NO_PROGRESS);
  /** The sentences to read; null while they are picked again after the new items. */
  const [reading, setReading] = useState<SentenceLike[] | null>([]);
  const [readIndex, setReadIndex] = useState(0);
  const [tally, setTally] = useState({ reviews: 0, correct: 0 });
  const [streak, setStreak] = useState<StreakInfo>();
  const [sessionMs, setSessionMs] = useState(0);
  /** Everything introduced today, this sitting or earlier ones, once the summary has looked it up. */
  const [learnedTodayLabels, setLearnedTodayLabels] = useState<LearnedLabel[]>();

  useScrollToTop(`${step}:${learnIndex}`);

  const started = useRef(false);
  /** Marking the day complete; stats go up once it has landed. */
  const completion = useRef<Promise<void> | null>(null);
  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const plan = await planToday();
      const sentences = await sentencesById(plan.reading);
      const next = { plan, sentences };
      setLoaded(next);
      setReading(sentences);
      setStep(firstStep(next) ?? 'review');
    } catch (e) {
      console.error('could not plan the session', e);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const answered = useCallback((correct: boolean) => {
    setTally((t) => ({ reviews: t.reviews + 1, correct: t.correct + (correct ? 1 : 0) }));
  }, []);

  const goTo = (next: Step) => {
    void timer.flush();
    if (next === 'summary') {
      setSessionMs(timer.elapsed());
      completion.current = completeSession().then(setStreak, (e: unknown) => console.error('could not complete the session', e));
      void learnedToday().then(learnedLabels).then(setLearnedTodayLabels, (e: unknown) => console.error('could not list what was learned today', e));
    }
    setStep(next);
  };

  // ---- The back gesture asks before stopping, like the close button ----
  const inSession = loaded !== null && firstStep(loaded) !== null;
  const guarded = (location.state as Record<string, unknown> | null)?.[BACK_GUARD] === true;
  /** The guard entry is on top of the session's own. */
  const armed = useRef(false);
  const arming = useRef(false);
  /** Leaving for Today: the guard entry is being taken off first. */
  const leaving = useRef(false);

  /**
   * To Today, replacing the session's history entry so back from Today doesn't
   * land in the stopped session. The guard entry on top goes first (back); the
   * effect below then replaces the session's own entry.
   */
  const exit = () => {
    if (armed.current) {
      leaving.current = true;
      navigate(-1);
      return;
    }
    navigate('/', { replace: true });
  };

  const leave = () => {
    void timer.flush();
    if (step === 'read') {
      // Reviews and new items are done; reading is the optional last part, so stopping here still
      // completes the day. (Reopened, the session would only have reading left and show "all caught up".)
      void completeSession().then(() => pushStats({ immediate: true }), (e: unknown) => console.error('could not complete the session', e));
    } else {
      void pushStats();
    }
    exit();
  };

  const finish = () => {
    void Promise.resolve(completion.current).then(() => pushStats({ immediate: true }));
    exit();
  };

  const latest = useRef({ step, finish, navigate });
  latest.current = { step, finish, navigate };
  const arm = useCallback(() => {
    arming.current = true;
    navigate(location.pathname, { state: { [BACK_GUARD]: true } });
  }, [navigate, location.pathname]);

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
    if (leaving.current) latest.current.navigate('/', { replace: true });
    else if (latest.current.step === 'summary') latest.current.finish();
    else setConfirming('back');
  }, [inSession, guarded, arm]);

  if (loadError) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={0} label="" onClose={() => navigate('/')} title="Today's session" />
        <div className="card st-error" role="alert">
          <p>Today's session couldn't load. If this is the first time on this phone, connect to the internet once so the lessons can download.</p>
          <button type="button" className="btn ink" onClick={() => void load()}>Try again</button>
        </div>
      </Screen>
    );
  }
  if (!loaded) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={0} label="" onClose={() => navigate('/')} title="Today's session" />
        <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Planning today's session" />
      </Screen>
    );
  }

  const { plan } = loaded;
  if (!firstStep(loaded)) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={1} label="" onClose={() => navigate('/')} />
        <SessionEmpty limitReached={plan.backlog > 0} newBlocked={plan.newBlocked?.reason} />
      </Screen>
    );
  }

  const sentences = reading ?? [];

  /** Reading, with sentences picked again when new items were just learned; else straight to the summary. */
  const toReading = (afterLearning: boolean) => {
    if (!afterLearning) {
      goTo(sentences.length ? 'read' : 'summary');
      return;
    }
    const planned = sentences;
    setReading(null);
    goTo('read');
    void planReading().then(sentencesById).then(
      (fresh) => {
        setReading(fresh);
        if (!fresh.length) goTo('summary');
      },
      (e: unknown) => {
        console.error('could not pick the reading again', e);
        setReading(planned);
        if (!planned.length) goTo('summary');
      },
    );
  };
  const afterReview = () => (plan.newItems.length ? goTo('learn') : toReading(false));

  const learnDone = (item: LearnedItem) => {
    const all = [...learned, item];
    setLearned(all);
    if (learnIndex + 1 < plan.newItems.length) {
      setLearnIndex(learnIndex + 1);
      return;
    }
    // The first check covers the new cards in a mixed order; the rest come with tomorrow's reviews.
    const { check, later } = splitFirstCheck(all);
    void deferNewCards(later).catch((e: unknown) => console.error('could not schedule the new cards', e));
    setCheckIds(shuffle(check));
    if (check.length) goTo('check');
    else toReading(true);
  };

  // Progress over every step; the check's size is estimated until it is known.
  const checkTotal = checkIds?.length ?? expectedChecks(plan);
  const total = plan.reviews.length + plan.newItems.length + checkTotal + sentences.length;
  const order: Step[] = ['review', 'learn', 'check', 'read', 'summary'];
  const past = (s: Step) => order.indexOf(step) > order.indexOf(s);
  const done =
    (past('review') ? plan.reviews.length : step === 'review' ? reviewProgress.done : 0)
    + (past('learn') ? plan.newItems.length : step === 'learn' ? learnIndex : 0)
    + (past('check') ? checkTotal : step === 'check' ? checkProgress.done : 0)
    + (past('read') ? sentences.length : step === 'read' ? readIndex : 0);

  const blockLabel = (name: string, p: BlockProgress) =>
    p.practice ? `Once more ${p.position} / ${p.total}` : `${name} ${Math.min(p.position, p.total)} / ${p.total}`;
  const label = {
    review: blockLabel('Review', reviewProgress),
    learn: `New ${learnIndex + 1} / ${plan.newItems.length}`,
    check: blockLabel('Check', checkProgress),
    read: reading ? `Read ${readIndex + 1} / ${sentences.length}` : 'Read',
    summary: 'Done',
  }[step];

  const stats: SessionStats = {
    ms: sessionMs,
    reviews: tally.reviews,
    correct: tally.correct,
    learned: learnedTodayLabels ?? learned.map((l) => l.label).filter((l) => l.text),
  };

  const keepGoing = () => {
    // Back from the dialog put the guard entry away; put it back for next time.
    if (confirming === 'back') arm();
    setConfirming(false);
  };

  return (
    <Screen label="Today's session">
      <SessionHeader progress={total ? done / total : 1} label={label}
        title={step === 'summary' ? undefined : "Today's session"}
        onClose={() => (step === 'summary' ? finish() : setConfirming('close'))} />

      {step === 'review' && (
        <ReviewBlock key="review" cardIds={plan.reviews} timer={timer} onProgress={setReviewProgress}
          onAnswered={answered} onDone={afterReview} />
      )}
      {step === 'learn' && plan.newItems[learnIndex] && (
        <NewItemFlow key={plan.newItems[learnIndex].itemId} plan={plan.newItems[learnIndex]} onDone={learnDone} />
      )}
      {step === 'check' && checkIds && (
        <>
          {checkProgress.done === 0 && !checkProgress.practice && (
            <p className="st-intro">A quick first check of what you just learned.</p>
          )}
          <ReviewBlock key="check" cardIds={checkIds} timer={timer} onProgress={setCheckProgress}
            onAnswered={answered} onDone={() => toReading(true)} />
        </>
      )}
      {step === 'read' && (reading ? (
        <ReadingDrill sentences={reading} onProgress={setReadIndex} onDone={() => goTo('summary')} doneLabel="Finish" />
      ) : (
        <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Finding sentences to read" />
      ))}
      {step === 'summary' && (
        <SessionSummary stats={stats} streak={streak} newBlocked={plan.newBlocked?.reason} onDone={finish} />
      )}

      {confirming && <StopDialog onKeepGoing={keepGoing} onStop={leave} />}
    </Screen>
  );
}
