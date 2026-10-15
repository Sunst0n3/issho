import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ChapterLine } from '../components/home/ChapterLine.tsx';
import { dismiss, isDismissed, loadHabitSnapshot } from '../components/home/habitData.ts';
import { dateOfKey, greeting, WEEKDAYS_EN, WEEKDAYS_JA } from '../components/home/labels.ts';
import { NewToday, newItemTiles } from '../components/home/NewToday.tsx';
import { ConnectHint, PartnerCard, SyncFooter } from '../components/home/PartnerCard.tsx';
import { PlanPanel, plannedItems } from '../components/home/PlanPanel.tsx';
import { SecureNotice } from '../components/home/SecureNotice.tsx';
import { StreakCard } from '../components/home/StreakCard.tsx';
import {
  choosePrompt,
  FreshStartHeader,
  MakeupLater,
  TodayPrompt,
  type TodayPromptKind,
} from '../components/home/TodayPrompts.tsx';
import { useClockTick, useLive } from '../components/home/useLive.ts';
import { TogetherTodayCard } from '../components/together/TogetherTodayCard.tsx';
import { Icon, Screen } from '../components/ui.tsx';
import { dayKey, getSettings } from '../lib/db.ts';
import { courseProgress } from '../srs/course.ts';
import { planToday } from '../srs/planner.ts';
import { setDefaultAudioRate } from '../speech/audio.ts';
import { isPairedSettings } from '../sync/client.ts';
import '../components/home/home.css';

const PROMPTS: readonly TodayPromptKind[] = ['rest-token', 'comeback', 'travel', 'plan-review', 'makeup'];

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
  const habits = useLive(() => loadHabitSnapshot(), [tick]);
  const today = useLive(async () => {
    const [plan, progress] = await Promise.all([planToday(), courseProgress()]);
    return { plan, progress, tiles: await newItemTiles(plannedItems(plan)) };
  }, [tick]);
  // Prompts put away ("Not now") in this visit, as 'kind@day'; earlier visits' come from storage.
  const [putAway, setPutAway] = useState<ReadonlySet<string>>(() => new Set());

  const courseDay = today.status === 'ready' ? today.value.plan.courseDay : undefined;
  const audioRate = settings?.audioRate;
  useEffect(() => {
    if (courseDay !== undefined) setDefaultAudioRate(courseDay, audioRate);
  }, [courseDay, audioRate]);

  if (!settings) return <TodaySkeleton />;
  if (!settings.onboarded) return <Navigate to="/welcome" replace />;

  const now = new Date();
  const todayKey = dayKey(now);
  const studyDay = dateOfKey(todayKey).getDay();
  const paired = isPairedSettings(settings);
  const h = habits.status === 'ready' ? habits.value : undefined;
  const dismissed = new Set(PROMPTS.filter((p) => putAway.has(`${p}@${todayKey}`) || isDismissed(p, todayKey)));
  const promptInputs = h && { today: h.today, streak: h.streak, comeback: h.comeback, settings, dismissed };
  const prompt = promptInputs ? choosePrompt(promptInputs) : null;
  const goalMet = Boolean(h?.streak.todayGoal);

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

      {h
        ? <StreakCard info={h.streak} freshStart={settings.freshStart && settings.freshStart <= todayKey ? settings.freshStart : undefined} />
        : <div className="hm-skeleton streak" aria-hidden="true" />}

      <FreshStartHeader freshStart={settings.freshStart} today={todayKey} />
      {promptInputs && (
        <TodayPrompt kind={prompt} inputs={promptInputs} freshStart={settings.freshStart}
          onDismiss={(kind) => {
            dismiss(kind, todayKey);
            setPutAway((set) => new Set(set).add(`${kind}@${todayKey}`));
          }} />
      )}

      {today.status === 'loading' && <div className="hm-skeleton panel" aria-hidden="true" />}
      {today.status === 'error' && (
        <section className="card hm-notice" role="alert">
          <h2 className="hm-notice-title">Today's plan didn't load</h2>
          <p className="muted">Your progress is safe on this phone. The study data may still be downloading.</p>
          <button type="button" className="btn secondary small" onClick={today.retry}>Try again</button>
        </section>
      )}
      {today.status === 'ready' && <PlanPanel plan={today.value.plan} goalMet={goalMet} />}
      {h && <MakeupLater streak={h.streak} comeback={h.comeback} />}

      <TogetherTodayCard />

      {today.status === 'ready' && !goalMet && <NewToday tiles={today.value.tiles} />}

      {paired ? <PartnerCard /> : <ConnectHint />}

      {today.status === 'ready' && <ChapterLine progress={today.value.progress} />}

      <SyncFooter paired={paired} />
    </Screen>
  );
}
