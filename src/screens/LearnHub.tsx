import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CanDoList, ReadyCanDos, readyCanDos } from '../components/home/CanDoList.tsx';
import { ChapterCard } from '../components/home/ChapterCard.tsx';
import { CoverageCard } from '../components/home/CoverageCard.tsx';
import { HoursCard } from '../components/home/HoursCard.tsx';
import { plural } from '../components/home/labels.ts';
import { MilestonesCard } from '../components/home/MilestonesCard.tsx';
import { RetentionCard } from '../components/home/RetentionCard.tsx';
import { SeasonCard, seasonNumbers } from '../components/home/SeasonCard.tsx';
import { SpeedCard } from '../components/home/SpeedCard.tsx';
import { useLive } from '../components/home/useLive.ts';
import { Icon, Screen } from '../components/ui.tsx';
import { loadUnits } from '../lib/data.ts';
import { dayKey, db, getSettings } from '../lib/db.ts';
import { canDoStatus } from '../srs/candos.ts';
import { courseProgress, currentUnit } from '../srs/course.ts';
import { firstStudyDay } from '../srs/habits.ts';
import { chapterInfo, seasonFinaleDue } from '../srs/milestones.ts';
import { hoursTotal, learnedCounts, readingSpeed, retention } from '../srs/progress.ts';
import { isPairedSettings } from '../sync/client.ts';
import '../components/home/home.css';
import '../components/home/library.css';

async function loadHub(now: Date = new Date()) {
  const [progress, learned, units, unitId, status, grammarIds, stats, hours, speed, firstDay, milestones, settings] = await Promise.all([
    courseProgress(now),
    learnedCounts(now),
    loadUnits(),
    currentUnit(now),
    canDoStatus(),
    db.items.where('kind').equals('grammar').primaryKeys(),
    retention(now),
    hoursTotal(),
    readingSpeed(),
    firstStudyDay(now),
    db.milestones.toArray(),
    getSettings(),
  ]);
  const today = dayKey(now);
  const seen = new Set(milestones.filter((m) => m.seenAt).map((m) => m.id));
  const passed = [...status.values()].filter((r) => r.passedAt).sort((a, b) => b.passedAt!.getTime() - a.passedAt!.getTime());
  const grammarIntroduced = new Set(grammarIds.map((id) => String(id).slice('grammar:'.length)));
  const season = seasonFinaleDue(firstDay, today, seen);
  return {
    progress,
    learned,
    chapter: chapterInfo(progress.kanjiIntroduced, progress.kanaIntroduced, progress.kanaTotal),
    unit: units.find((u) => u.id === unitId),
    ready: readyCanDos(units, unitId, status, grammarIntroduced),
    status,
    grammarIntroduced,
    retention: stats,
    hours,
    speed,
    season: season === null ? null : { number: season, counts: await seasonNumbers(season, firstDay) },
    passedCanDo: passed[0]?.id,
    paired: isPairedSettings(settings),
  };
}

function HubTile({ to, mark, title, sub, wide }: { to: string; mark: ReactNode; title: string; sub?: string; wide?: boolean }) {
  return (
    // Named explicitly: read from content, the title and the line under it run together.
    <Link to={to} className={wide ? 'hub-tile wide' : 'hub-tile'} aria-label={sub ? `${title}, ${sub}` : title}>
      <span className="hub-mark" lang="ja" aria-hidden="true">{mark}</span>
      <span className="hub-text">
        <span className="hub-title">{title}</span>
        {sub && <span className="hub-sub">{sub}</span>}
      </span>
      {wide && <Icon name="forward" size={20} />}
    </Link>
  );
}

export default function LearnHub() {
  const hub = useLive(() => loadHub(), []);
  const h = hub.status === 'ready' ? hub.value : undefined;

  return (
    <Screen tabs label="Learn">
      <header>
        <p className="hm-eyebrow" lang="ja">学ぶ</p>
        <h1 className="hm-page-title">Learn</h1>
      </header>

      {hub.status === 'loading' && <div className="hm-skeleton card-sized" aria-hidden="true" />}
      {hub.status === 'error' && (
        <section className="card hm-notice" role="alert">
          <h2 className="hm-notice-title">Your progress didn't load</h2>
          <p className="muted">The study data may still be downloading.</p>
          <button type="button" className="btn secondary small" onClick={hub.retry}>Try again</button>
        </section>
      )}

      {h?.season && (
        <SeasonCard season={h.season.number} counts={h.season.counts} paired={h.paired} passedCanDo={h.passedCanDo} />
      )}
      {h && <ChapterCard info={h.chapter} theme={h.unit?.title} />}
      {h?.unit && <CanDoList unit={h.unit} status={h.status} grammarIntroduced={h.grammarIntroduced} />}
      {h && <ReadyCanDos ready={h.ready} />}

      <nav className="hub-tiles" aria-label="Study areas">
        <HubTile to="/library" mark="漢" title="Library" wide
          sub={h ? `${plural(h.progress.kanjiIntroduced, 'kanji', 'kanji')} and ${plural(h.learned.wordsIntroduced, 'word')} so far` : undefined} />
        {/* "Met" (introduced), as the library's words: "learned" means 3 spaced successes (§3.1.13). */}
        <HubTile to="/kana" mark="あ" title="Kana chart"
          sub={h ? `${h.progress.kanaIntroduced} of ${h.progress.kanaTotal} basic kana met` : undefined} />
        <HubTile to="/grammar" mark="は" title="Grammar"
          sub={h ? `${plural(h.progress.grammarIntroduced, 'point')} met so far` : undefined} />
        <HubTile to="/library/stories" mark="読" title="Stories" sub="Read and listen" />
        <HubTile to="/roleplay" mark="話" title="Role-plays" sub="Scenes to act out" />
      </nav>

      {h && <CoverageCard kanjiCanRead={h.learned.kanjiCanRead} wordsKnown={h.learned.wordsLearned} />}
      {h && <RetentionCard stats={h.retention} />}
      {h && <HoursCard hours={h.hours} />}
      {h && <SpeedCard latest={h.speed.latest} best={h.speed.best} />}
      {h && <MilestonesCard counts={{ ...h.learned, kanaIntroduced: h.progress.kanaIntroduced, kanaTotal: h.progress.kanaTotal }} />}
    </Screen>
  );
}
