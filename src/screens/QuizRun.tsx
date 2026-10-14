// A quiz from your partner: their hardest kanji. For each one you've learned,
// pick its meaning, then write it from memory. Ones you haven't met yet are
// shown as a preview and skipped. This is a game: it never touches your reviews.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Quiz } from '../../shared/api.ts';
import { Glyph } from '../components/Glyph.tsx';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { QuizSender } from '../components/together/QuizSender.tsx';
import { memberName } from '../components/together/household.ts';
import { finishQuiz, useQuizzes } from '../components/together/quizzes.ts';
import '../components/together/together.css';
import { Icon, ProgressBar, Screen, TopBar } from '../components/ui.tsx';
import { loadKanji } from '../lib/data.ts';
import { db } from '../lib/db.ts';
import { useSettings, useSettingsLoaded } from '../lib/hooks.ts';
import type { KanjiEntry } from '../lib/types.ts';
import { choicesFrom, gradeForWriting } from '../srs/answers.ts';
import { useHousehold } from '../sync/stats.ts';
import { useStrokes } from '../writing/useStrokes.ts';
import { WritingPad, type WritingPadHandle, type WritingResult } from '../writing/WritingPad.tsx';

const CHOICES = 4;
/** Writing graded Again (gave up, or most strokes missed) counts as a miss. */
const AGAIN = 1;

interface QuizItem {
  char: string;
  entry?: KanjiEntry;
  introduced: boolean;
  choices: string[];
}

type Outcome = 'right' | 'missed' | 'new';

export default function QuizRun() {
  const { id = '' } = useParams();
  const settings = useSettings();
  const loaded = useSettingsLoaded();
  const { data, loading, error, refresh } = useQuizzes();
  const household = useHousehold();
  const quiz = data?.inbox.find((q) => q.id === id) ?? data?.sent.find((q) => q.id === id);
  const nameOf = (memberId: string) => memberName(household.data, memberId);

  // Keep playing once started, even after the finished result lands in the cache.
  const [playing, setPlaying] = useState<string>();
  if (quiz && !quiz.result && quiz.toMemberId === settings.memberId && playing !== quiz.id) setPlaying(quiz.id);

  if (!loaded) return <Screen label="Quiz"><div className="tg-skeleton-block tg-tall" aria-busy="true" /></Screen>;

  if (!settings.deviceToken) {
    return (
      <Screen label="Quiz">
        <TopBar back="/together" title="Quiz" />
        <p className="muted">Quizzes come from your partner through your home server. Connect this phone first.</p>
        <ConnectServerForm compact onConnected={() => void refresh()} />
      </Screen>
    );
  }

  if (!quiz) {
    const waiting = loading || (!data && !error);
    return (
      <Screen label="Quiz">
        <TopBar back="/together" title="Quiz" />
        {waiting ? (
          <div className="tg-skeleton-block tg-tall" aria-busy="true" aria-label="Loading the quiz" />
        ) : (
          <div className="tg-notice-card" role="alert">
            <h2>{error ? "Couldn't load this quiz" : "This quiz isn't here anymore"}</h2>
            <p>
              {error
                ? navigator.onLine === false ? "You're offline. Quizzes come through your home server." : "Your home server didn't answer."
                : 'It may have been replaced by a newer one.'}
            </p>
            {error && <button type="button" className="btn secondary small" onClick={() => void refresh()}>Try again</button>}
            <Link className="btn ghost small" to="/together">Back to Together</Link>
          </div>
        )}
      </Screen>
    );
  }

  if (playing === quiz.id) return <QuizPlay quiz={quiz} fromName={nameOf(quiz.fromMemberId)} />;

  const sentByMe = quiz.fromMemberId === settings.memberId;
  const otherName = nameOf(sentByMe ? quiz.toMemberId : quiz.fromMemberId);
  const result = quiz.result;
  return (
    <Screen label="Quiz">
      <TopBar back="/together" title="Quiz" />
      <section className="card tg-quiz-summary">
        <p className="label">{sentByMe ? `Your quiz for ${otherName}` : `Quiz from ${otherName}`}</p>
        <p className="tg-quiz-chars" lang="ja">{quiz.items.map((i) => i.char).join(' ')}</p>
        {result ? (
          <p>
            {sentByMe ? `${otherName} got` : 'You got'} <strong>{result.correct} / {result.total}</strong>
            {result.missed.length > 0 && <> — missed <span lang="ja" className="tg-missed-kanji">{result.missed.join(' ')}</span></>}
          </p>
        ) : (
          <p className="muted">Waiting for {otherName} to take it.</p>
        )}
      </section>
      {!sentByMe && <QuizSender partnerId={quiz.fromMemberId} partnerName={otherName} heading="Send back a quiz" />}
      <Link className="btn secondary block" to="/together">Back to Together</Link>
    </Screen>
  );
}

function QuizPlay({ quiz, fromName }: { quiz: Quiz; fromName: string }) {
  const [items, setItems] = useState<QuizItem[]>();
  const [failed, setFailed] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  // The cached quiz object is replaced by every refresh and when the result lands;
  // preparing again would reshuffle the choices under the learner's finger.
  const quizRef = useRef(quiz);
  quizRef.current = quiz;

  useEffect(() => {
    let live = true;
    prepare(quizRef.current).then((p) => { if (live) setItems(p); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [quiz.id]);

  const index = outcomes.length;
  if (failed) {
    return (
      <Screen label="Quiz">
        <TopBar close="/together" title="Quiz" />
        <div className="tg-notice-card" role="alert">
          <h2>The kanji didn't load</h2>
          <p>Something went wrong reading the kanji on this phone.</p>
          <Link className="btn secondary small" to="/together">Back to Together</Link>
        </div>
      </Screen>
    );
  }
  if (!items) {
    return (
      <Screen label="Quiz">
        <TopBar close="/together" title="Quiz" />
        <div className="tg-skeleton-block tg-tall" aria-busy="true" aria-label="Getting the quiz ready" />
      </Screen>
    );
  }
  if (index >= items.length) return <QuizEnd quiz={quiz} items={items} outcomes={outcomes} fromName={fromName} />;

  return (
    <Screen label="Quiz">
      <TopBar close="/together" title={<ProgressBar value={index / items.length} label="Quiz progress" />}
        right={<span className="tg-rp-count">{index + 1} / {items.length}</span>} />
      <p className="tg-eyebrow">Quiz from {fromName}</p>
      <QuizStep key={index} item={items[index]} onDone={(o) => setOutcomes((prev) => [...prev, o])} />
    </Screen>
  );
}

/** Looks up each kanji and whether this learner has met it, and builds meaning choices. */
async function prepare(quiz: Quiz): Promise<QuizItem[]> {
  const [kanji, introducedItems] = await Promise.all([
    loadKanji(),
    db.items.where('kind').equals('kanji').primaryKeys(),
  ]);
  const known = introducedItems.map((k) => String(k).slice('kanji:'.length));
  const knownSet = new Set(known);
  const all = Object.values(kanji);
  return quiz.items.map(({ char }) => {
    const entry = kanji[char];
    const introduced = knownSet.has(char);
    if (!entry || !introduced) return { char, entry, introduced, choices: [] };
    const correct = entry.meanings[0];
    const own = new Set(entry.meanings.map((m) => m.toLowerCase()));
    // Distractors from kanji the learner knows first, then kanji of similar frequency.
    const near = [...all]
      .filter((k) => k.char !== char && !knownSet.has(k.char))
      .sort((a, b) => Math.abs((a.freq ?? 2500) - (entry.freq ?? 2500)) - Math.abs((b.freq ?? 2500) - (entry.freq ?? 2500)))
      .slice(0, 20);
    const pool = [...known.filter((k) => k !== char).map((k) => kanji[k]).filter(Boolean), ...near]
      .map((k) => k.meanings[0])
      .filter((m) => m && !own.has(m.toLowerCase()));
    return { char, entry, introduced, choices: choicesFrom(correct, pool.slice(0, 30), CHOICES, (m) => m.toLowerCase()) };
  });
}

function readingOf(entry: KanjiEntry): string {
  const kun = entry.kun[0]?.replace(/[.-]/g, '');
  return kun || entry.on[0] || '';
}

function QuizStep({ item, onDone }: { item: QuizItem; onDone(outcome: Outcome): void }) {
  const [stage, setStage] = useState<'meaning' | 'write'>('meaning');
  const [picked, setPicked] = useState<string>();
  const [written, setWritten] = useState<WritingResult>();
  const pad = useRef<WritingPadHandle>(null);
  const { strokes, missing, error } = useStrokes(item.introduced ? item.char : undefined);
  const entry = item.entry;

  if (!item.introduced || !entry) {
    return (
      <section className="card tg-quiz-card-body tg-new-kanji" aria-labelledby="quiz-new">
        <span className="chip ai">New to you</span>
        <div className="tg-quiz-glyph"><Glyph char={item.char} size={96} /></div>
        <h1 id="quiz-new" className="tg-quiz-meaning">{entry?.meanings.slice(0, 3).join(', ') ?? 'Not in your course yet'}</h1>
        {entry && (
          <dl className="tg-quiz-readings">
            {entry.kun.length > 0 && <div><dt>Kun</dt><dd lang="ja">{entry.kun.slice(0, 3).join('、')}</dd></div>}
            {entry.on.length > 0 && <div><dt>On</dt><dd lang="ja">{entry.on.slice(0, 3).join('、')}</dd></div>}
          </dl>
        )}
        <p className="muted">You haven't learned this one yet, so it's skipped. It will come up in your lessons.</p>
        <button type="button" className="btn ink block" onClick={() => onDone('new')}>Continue</button>
      </section>
    );
  }

  const correct = entry.meanings[0];
  const meaningRight = picked === correct;
  // Without stroke data (rare) the kanji is scored on its meaning alone.
  const noStrokes = missing || Boolean(error);

  if (stage === 'meaning') {
    return (
      <section className="tg-quiz-card-body" aria-labelledby="quiz-q">
        <h1 id="quiz-q" className="tg-quiz-prompt">What does this kanji mean?</h1>
        <div className="tg-quiz-glyph"><Glyph char={item.char} size={96} /></div>
        <div className="choice-grid">
          {item.choices.map((c) => {
            const state = picked === undefined ? '' : c === correct ? ' correct' : c === picked ? ' wrong' : '';
            return (
              <button key={c} type="button" className={`choice${state}`} disabled={picked !== undefined}
                onClick={() => setPicked(c)}>
                {c}
              </button>
            );
          })}
        </div>
        {picked !== undefined && (
          <>
            <div className={meaningRight ? 'feedback good' : 'feedback bad'} role="status">
              <strong>{meaningRight ? 'Right' : 'Not quite'}</strong>
              <span><span lang="ja">{item.char}</span> means “{entry.meanings.slice(0, 2).join(', ')}”.</span>
            </div>
            <button type="button" className="btn ink block" disabled={!noStrokes && !strokes}
              onClick={() => (noStrokes ? onDone(meaningRight ? 'right' : 'missed') : setStage('write'))}>
              {noStrokes ? 'Next' : 'Now write it'}
            </button>
          </>
        )}
      </section>
    );
  }

  const grade = written ? gradeForWriting(written) : undefined;
  const writtenOk = grade !== undefined && grade > AGAIN;
  return (
    <section className="tg-quiz-card-body" aria-labelledby="quiz-w">
      <h1 id="quiz-w" className="tg-quiz-prompt">Write it from memory</h1>
      <p className="tg-quiz-target">{correct} <span lang="ja" className="jp-display">{readingOf(entry)}</span></p>
      {strokes && (
        <WritingPad ref={pad} strokes={strokes} mode="memory" label={`the kanji for ${correct}`} disabled={Boolean(written)}
          onComplete={setWritten} />
      )}
      {!written ? (
        <div className="tg-pad-tools">
          <button type="button" className="btn secondary small" onClick={() => pad.current?.undo()}>
            <Icon name="undo" size={18} />Undo
          </button>
          <button type="button" className="btn secondary small" onClick={() => pad.current?.hint()}>
            <Icon name="bulb" size={18} />Hint
          </button>
          <button type="button" className="btn secondary small" onClick={() => pad.current?.giveUp()}>
            I don't remember
          </button>
        </div>
      ) : (
        <>
          <div className={writtenOk ? 'feedback good' : 'feedback bad'} role="status">
            <strong>{written.gaveUp ? "Here's how it goes" : writtenOk ? 'Nicely written' : 'Not quite'}</strong>
            <span>
              {meaningRight && writtenOk ? 'That one counts.'
                : writtenOk ? 'The meaning tripped you up, so this one is a miss.'
                  : meaningRight ? 'You knew the meaning. The writing comes with practice.'
                    : 'This one comes with practice.'}
            </span>
          </div>
          <button type="button" className="btn ink block" onClick={() => onDone(meaningRight && writtenOk ? 'right' : 'missed')}>
            Next
          </button>
        </>
      )}
    </section>
  );
}

function QuizEnd({ quiz, items, outcomes, fromName }: {
  quiz: Quiz;
  items: QuizItem[];
  outcomes: Outcome[];
  fromName: string;
}) {
  const total = outcomes.filter((o) => o !== 'new').length;
  const correct = outcomes.filter((o) => o === 'right').length;
  const missed = items.filter((_, i) => outcomes[i] === 'missed').map((i) => i.char);
  const [sending, setSending] = useState<'sending' | 'sent' | 'queued' | 'failed'>('sending');
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    finishQuiz(quiz, { correct, total, missed }).then(setSending, () => setSending('failed'));
  }, [quiz, correct, total, missed]);

  return (
    <Screen label="Quiz finished">
      <TopBar close="/together" title="Quiz" />
      <section className="tg-quiz-end" aria-labelledby="quiz-score">
        <p className="tg-eyebrow">Quiz from {fromName}</p>
        {total > 0 ? (
          <h1 id="quiz-score" className="tg-quiz-score">{correct} <span>/ {total}</span></h1>
        ) : (
          <h1 id="quiz-score" className="tg-together-title">All new to you</h1>
        )}
        <p>
          {total === 0 ? `${fromName} is ahead on these. They'll come up in your lessons.`
            : correct === total ? 'Every one. Nicely done.'
              : 'The ones you missed are worth an extra look in your reviews.'}
        </p>
        <ul className="tg-quiz-results">
          {items.map((it, i) => (
            <li key={it.char} className={`tg-quiz-result tg-is-${outcomes[i]}`}>
              <Glyph char={it.char} size={34} />
              <span>{outcomes[i] === 'right' ? 'Right' : outcomes[i] === 'missed' ? 'Missed' : 'New'}</span>
            </li>
          ))}
        </ul>
        <p className="tg-sync-status" role="status">
          {sending === 'sending' && 'Sending your score…'}
          {sending === 'sent' && <><Icon name="check" size={16} />{fromName} can see your score now.</>}
          {sending === 'queued' && <><Icon name="cloudOff" size={16} />You're offline. Your score goes to {fromName} when you reconnect.</>}
          {sending === 'failed' && "Your score couldn't be sent. The quiz may have been removed."}
        </p>
      </section>
      <QuizSender partnerId={quiz.fromMemberId} partnerName={fromName} heading="Send back a quiz" />
      <Link className="btn secondary block" to="/together">Back to Together</Link>
    </Screen>
  );
}
