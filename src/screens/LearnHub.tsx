import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  PHASE_NAMES,
  phaseDetail,
  phaseFraction,
  phaseKanjiTargets,
  phaseProgressText,
  plural,
  type KanjiTargets,
} from '../components/home/labels.ts';
import { useLive } from '../components/home/useLive.ts';
import { Icon, ProgressBar, Screen } from '../components/ui.tsx';
import { loadCurriculum, loadGrammar, loadRolePlays } from '../lib/data.ts';
import { db } from '../lib/db.ts';
import { courseProgress, type CourseProgress, type Phase } from '../srs/course.ts';
import '../components/home/home.css';

const ALL_PHASES: Phase[] = [1, 2, 3, 4];

function PhaseCard({ progress, targets }: { progress: CourseProgress; targets: KanjiTargets }) {
  const current = progress.phase;
  return (
    <section className="card learn-phase" aria-labelledby="phase-title">
      <div>
        <p className="label">Your path</p>
        <h2 id="phase-title" className="hm-notice-title">Phase {current} of 4</h2>
      </div>
      <ol className="roadmap">
        {ALL_PHASES.map((n) => {
          const state = n < current ? 'done' : n === current ? 'current' : 'later';
          return (
            <li key={n} className={state} aria-current={n === current ? 'step' : undefined}>
              <span className="roadmap-num" aria-hidden="true">{n < current ? <Icon name="check" size={14} strokeWidth={3} /> : n}</span>
              <div className="roadmap-body">
                <span className="roadmap-name">
                  {PHASE_NAMES[n]}
                  {n < current && <span className="visually-hidden"> (done)</span>}
                </span>
                <span className="roadmap-detail">{phaseDetail(n, targets)}</span>
                {n === current && (
                  <div className="roadmap-progress">
                    <ProgressBar value={phaseFraction(progress, targets[4])} label={`Progress in phase ${n}`} />
                    <span>{phaseProgressText(progress, targets[4])}</span>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function HubTile({ to, mark, title, sub, wide }: { to: string; mark: ReactNode; title: string; sub?: string; wide?: boolean }) {
  return (
    <Link to={to} className={wide ? 'hub-tile wide' : 'hub-tile'}>
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
  const hub = useLive(async () => {
    const [progress, curriculum, grammar, rolePlays, grammarDone] = await Promise.all([
      courseProgress(),
      loadCurriculum(),
      loadGrammar(),
      loadRolePlays(),
      db.items.where('kind').equals('grammar').count(),
    ]);
    return { progress, targets: phaseKanjiTargets(curriculum), grammarTotal: grammar.length, grammarDone, rolePlays: rolePlays.length };
  }, []);
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
      {h && <PhaseCard progress={h.progress} targets={h.targets} />}

      <nav className="hub-tiles" aria-label="Study areas">
        <HubTile to="/kanji" mark="漢" title="Kanji library" wide
          sub={h ? `${plural(h.progress.kanjiIntroduced, 'kanji', 'kanji')} learned · ${h.targets[4].toLocaleString()} in all` : undefined} />
        <HubTile to="/kana" mark="あ" title="Kana chart"
          sub={h ? `${h.progress.kanaIntroduced} of ${h.progress.kanaTotal} learned` : undefined} />
        <HubTile to="/grammar" mark="は" title="Grammar"
          sub={h ? `${h.grammarDone} of ${h.grammarTotal}` : undefined} />
        <HubTile to="/read" mark="読" title="Read & shadow" sub="Listen, read, say it back" />
        <HubTile to="/roleplay" mark="話" title="Role-plays"
          sub={h ? `${plural(h.rolePlays, 'scene')} to act out` : 'Scenes to act out'} />
      </nav>
    </Screen>
  );
}
