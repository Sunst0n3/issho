// Today's session: reviews first, then new items (lesson + writing), a first
// check of the new cards, reading & shadowing, and a summary. The plan is
// taken once when the screen opens and never recomputed mid-session.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { State } from 'ts-fsrs';
import { useScrollToTop } from '../components/study/focus.ts';
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
import { planToday, type SessionPlan } from '../srs/planner.ts';
import { completeSession, type StreakInfo } from '../srs/progress.ts';
import { pushStats } from '../sync/stats.ts';
import '../components/study/study.css';

type Step = 'review' | 'learn' | 'check' | 'read' | 'summary';

interface Loaded {
  plan: SessionPlan;
  sentences: SentenceLike[];
}

const NO_PROGRESS: BlockProgress = { done: 0, position: 1, total: 0, practice: false };

/** Cards a new item brings (its own and its words'), for sizing the progress bar before they exist. */
function expectedChecks(plan: SessionPlan): number {
  return plan.newItems.reduce((n, item) => n + cardTypesFor(item.kind, item.key).length + (item.words?.length ?? 0) * 2, 0);
}

function firstStep(l: Loaded): Step | null {
  if (l.plan.reviews.length) return 'review';
  if (l.plan.newItems.length) return 'learn';
  return null;
}

export default function Session() {
  const navigate = useNavigate();
  const timer = useStudyTimer();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [step, setStep] = useState<Step>('review');
  const [confirming, setConfirming] = useState(false);

  const [reviewProgress, setReviewProgress] = useState(NO_PROGRESS);
  const [learnIndex, setLearnIndex] = useState(0);
  const [learned, setLearned] = useState<LearnedItem[]>([]);
  const [checkIds, setCheckIds] = useState<string[] | null>(null);
  const [checkProgress, setCheckProgress] = useState(NO_PROGRESS);
  const [readIndex, setReadIndex] = useState(0);
  const [tally, setTally] = useState({ reviews: 0, correct: 0 });
  const [streak, setStreak] = useState<StreakInfo>();
  const [sessionMs, setSessionMs] = useState(0);

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
    }
    setStep(next);
  };

  if (loadError) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={0} label="" onClose={() => navigate('/')} />
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
        <SessionHeader progress={0} label="" onClose={() => navigate('/')} />
        <div className="st-skeleton st-skeleton-card" aria-busy="true" aria-label="Planning today's session" />
      </Screen>
    );
  }

  const { plan, sentences } = loaded;
  if (!firstStep(loaded)) {
    return (
      <Screen label="Today's session">
        <SessionHeader progress={1} label="" onClose={() => navigate('/')} />
        <SessionEmpty limitReached={plan.backlog > 0} newBlocked={plan.newBlocked?.reason} />
      </Screen>
    );
  }

  const afterReview = (): Step => (plan.newItems.length ? 'learn' : sentences.length ? 'read' : 'summary');
  const afterCheck = (): Step => (sentences.length ? 'read' : 'summary');

  const learnDone = (item: LearnedItem) => {
    const all = [...learned, item];
    setLearned(all);
    if (learnIndex + 1 < plan.newItems.length) {
      setLearnIndex(learnIndex + 1);
      return;
    }
    // The first check covers every card the new items brought, in a mixed order.
    const fresh = all.flatMap((l) => l.results.flatMap((r) => r.cards.filter((c) => c.state === State.New).map((c) => c.id)));
    setCheckIds(shuffle(fresh));
    goTo(fresh.length ? 'check' : afterCheck());
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
    read: `Read ${readIndex + 1} / ${sentences.length}`,
    summary: 'Done',
  }[step];

  const leave = () => {
    void timer.flush();
    if (step === 'read') {
      // Reviews and new items are done; reading is the optional last part, so stopping here still
      // completes the day. (Reopened, the session would only have reading left and show "all caught up".)
      void completeSession().then(() => pushStats({ immediate: true }), (e: unknown) => console.error('could not complete the session', e));
    } else {
      void pushStats();
    }
    navigate('/');
  };

  const finish = () => {
    void Promise.resolve(completion.current).then(() => pushStats({ immediate: true }));
    navigate('/');
  };

  const stats: SessionStats = { ms: sessionMs, reviews: tally.reviews, correct: tally.correct, learned: learned.map((l) => l.label).filter((l) => l.text) };

  return (
    <Screen label="Today's session">
      <SessionHeader progress={total ? done / total : 1} label={label}
        onClose={() => (step === 'summary' ? finish() : setConfirming(true))} />

      {step === 'review' && (
        <ReviewBlock key="review" cardIds={plan.reviews} timer={timer} onProgress={setReviewProgress}
          onAnswered={answered} onDone={() => goTo(afterReview())} />
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
            onAnswered={answered} onDone={() => goTo(afterCheck())} />
        </>
      )}
      {step === 'read' && (
        <ReadingDrill sentences={sentences} onProgress={setReadIndex} onDone={() => goTo('summary')} doneLabel="Finish" />
      )}
      {step === 'summary' && (
        <SessionSummary stats={stats} streak={streak} newBlocked={plan.newBlocked?.reason} onDone={finish} />
      )}

      {confirming && <StopDialog onKeepGoing={() => setConfirming(false)} onStop={leave} />}
    </Screen>
  );
}
