import { useLiveQuery } from 'dexie-react-hooks';
import { Link, Navigate } from 'react-router-dom';
import { NewToday, newItemTiles } from '../components/home/NewToday.tsx';
import { ConnectHint, PartnerCard, SyncFooter } from '../components/home/PartnerCard.tsx';
import { SecureNotice } from '../components/home/SecureNotice.tsx';
import { SessionPanel } from '../components/home/SessionPanel.tsx';
import { StreakCard } from '../components/home/StreakCard.tsx';
import {
  dateOfKey,
  greeting,
  phaseFraction,
  phaseProgressText,
  WEEKDAYS_EN,
  WEEKDAYS_JA,
} from '../components/home/labels.ts';
import { useClockTick, useLive } from '../components/home/useLive.ts';
import { Icon, Screen } from '../components/ui.tsx';
import { dayKey, getSettings } from '../lib/db.ts';
import { courseProgress, type CourseProgress } from '../srs/course.ts';
import { planToday } from '../srs/planner.ts';
import { streak } from '../srs/progress.ts';
import { isPairedSettings } from '../sync/client.ts';
import '../components/home/home.css';

function PhaseLine({ progress }: { progress: CourseProgress }) {
  const pct = `${Math.round(phaseFraction(progress) * 100)}%`;
  return (
    <Link to="/learn" className="today-phase">
      <span className="today-phase-text">
        <strong>Phase {progress.phase}</strong> · {phaseProgressText(progress)}
      </span>
      <span className="today-phase-bar" aria-hidden="true"><span style={{ width: pct }} /></span>
      <Icon name="forward" size={16} />
    </Link>
  );
}

function TodaySkeleton() {
  return (
    <Screen tabs label="Today">
      <div aria-busy="true" aria-label="Loading today" className="hm-skeleton-stack">
        <div className="hm-skeleton line" />
        <div className="hm-skeleton line title" />
        <div className="hm-skeleton streak" />
        <div className="hm-skeleton panel" />
      </div>
    </Screen>
  );
}

export default function Today() {
  // One query decides both "loaded" and "onboarded", so a returning learner
  // never sees a flash of the welcome redirect.
  const settings = useLiveQuery(() => getSettings(), []);
  const tick = useClockTick();
  const streakLive = useLive(() => streak(), [tick]);
  const today = useLive(async () => {
    const [plan, progress] = await Promise.all([planToday(), courseProgress()]);
    return {
      plan,
      progress,
      tiles: await newItemTiles(plan.newItems),
    };
  }, [tick]);

  if (!settings) return <TodaySkeleton />;
  if (!settings.onboarded) return <Navigate to="/welcome" replace />;

  const now = new Date();
  const studyDay = dateOfKey(dayKey(now)).getDay();
  const paired = isPairedSettings(settings);
  const todayDone = streakLive.status === 'ready' && streakLive.value.todayDone;

  return (
    <Screen tabs label="Today">
      <header className="today-head">
        <div>
          <p className="today-date">
            {WEEKDAYS_EN[studyDay]} · <span lang="ja">{WEEKDAYS_JA[studyDay]}</span>
          </p>
          <h1 className="today-greeting">{greeting(now)}{settings.name ? `, ${settings.name}` : ''}</h1>
        </div>
        <Link to="/settings" className="icon-btn outlined" aria-label="Settings">
          <Icon name="settings" size={22} />
        </Link>
      </header>

      <SecureNotice />

      {streakLive.status === 'ready'
        ? <StreakCard info={streakLive.value} />
        : <div className="hm-skeleton streak" aria-hidden="true" />}

      {today.status === 'loading' && <div className="hm-skeleton panel" aria-hidden="true" />}
      {today.status === 'error' && (
        <section className="card hm-notice" role="alert">
          <h2 className="hm-notice-title">Today's plan didn't load</h2>
          <p className="muted">Your progress is safe on this phone. The study data may still be downloading.</p>
          <button type="button" className="btn secondary small" onClick={today.retry}>Try again</button>
        </section>
      )}
      {today.status === 'ready' && (
        <>
          <SessionPanel
            plan={today.value.plan}
            todayDone={todayDone}
            // Nothing new is left at all (kana, kanji, words, grammar), and every kanji is met.
            courseFinished={today.value.plan.courseComplete === true
              && today.value.progress.unitsTotal > 0
              && today.value.progress.unitsIntroduced === today.value.progress.unitsTotal}
          />
          {!todayDone && <NewToday tiles={today.value.tiles} />}
        </>
      )}

      {paired ? <PartnerCard /> : <ConnectHint />}

      {today.status === 'ready' && <PhaseLine progress={today.value.progress} />}

      <SyncFooter paired={paired} />
    </Screen>
  );
}
