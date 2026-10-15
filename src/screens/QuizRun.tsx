// A quiz between partners.
//
// kanji (v1, kept for old inbox items): your partner's hardest kanji. For each one you've
// learned, pick its meaning, then write it from memory; ones you haven't met yet are shown as a
// preview and skipped. This is a game: it never touches your reviews.
//
// partner, dictation and monthly (the together sessions): the sender answered from their own
// cards and this phone asks. The asker sees each prompt with its answer and gives the verdict;
// the answerer's phone applies the verdicts to its reviews (only for cards near their due date)
// and never shows the answers.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PartnerQuizItem, Quiz, QuizVerdict } from '../../shared/api.ts';
import { Glyph } from '../components/Glyph.tsx';
import { ConnectServerForm } from '../components/together/ConnectServerForm.tsx';
import { useFocusWhenLost } from '../components/together/focus.ts';
import { memberName, midSentence } from '../components/together/household.ts';
import { QuizAnswerer, QuizAsker, resultOf, type TogetherQuizKind } from '../components/together/PartnerQuiz.tsx';
import { readingFor } from '../components/together/kanjiReading.ts';
import { finishQuiz, useQuizzes, useResultDelivery, type ResultDelivery } from '../components/together/quizzes.ts';
import '../components/together/together.css';
import { Icon, ProgressBar, Screen, TopBar } from '../components/ui.tsx';
import { loadKanji, loadWords } from '../lib/data.ts';
import { db } from '../lib/db.ts';
import { useSettings, useSettingsLoaded } from '../lib/hooks.ts';
import type { KanjiEntry, WordEntry } from '../lib/types.ts';
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
  /** Reading shown with the meaning when writing it from memory. */
  reading: string;
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
  // The hooks above run on every render; the views below may return early.

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

  // A quiz cached by a v1 phone has no kind: it is a kanji quiz.
  if ((quiz.kind ?? 'kanji') !== 'kanji') {
    if (playing === quiz.id) return <AskQuiz quiz={quiz} answererName={nameOf(quiz.fromMemberId)} />;
    return <TogetherQuizSummary quiz={quiz} answeredByMe={quiz.fromMemberId === settings.memberId}
      otherName={nameOf(quiz.fromMemberId === settings.memberId ? quiz.toMemberId : quiz.fromMemberId)} />;
  }

  if (playing === quiz.id) return <QuizPlay quiz={quiz} fromName={nameOf(quiz.fromMemberId)} />;

  const sentByMe = quiz.fromMemberId === settings.memberId;
  return <QuizSummary quiz={quiz} sentByMe={sentByMe} otherName={nameOf(sentByMe ? quiz.toMemberId : quiz.fromMemberId)} />;
}

function QuizSummary({ quiz, sentByMe, otherName }: { quiz: Quiz; sentByMe: boolean; otherName: string }) {
  const result = quiz.result;
  const chars = quizChars(quiz);
  // Characters Issho doesn't teach are skipped, not "new": the end screen says so too.
  const [kanji, setKanji] = useState<Record<string, KanjiEntry>>();
  useEffect(() => {
    let live = true;
    loadKanji().then((k) => { if (live) setKanji(k); }, () => { /* Then the counts below just aren't shown. */ });
    return () => { live = false; };
  }, []);
  const skipped = kanji ? chars.filter((c) => !kanji[c]).length : 0;
  // Kanji the taker hadn't learned yet aren't scored, as on the Together list.
  const fresh = result && kanji ? Math.max(0, chars.length - result.total - skipped) : 0;
  return (
    <Screen label="Quiz">
      <TopBar back="/together" title="Quiz" heading={false} />
      <section className="card tg-quiz-summary" aria-labelledby="quiz-summary-title">
        <h1 id="quiz-summary-title" className="label">{sentByMe ? `Your quiz for ${midSentence(otherName)}` : `Quiz from ${midSentence(otherName)}`}</h1>
        <p className="tg-quiz-chars" lang="ja">{chars.join(' ')}</p>
        {!result ? (
          <p className="muted">Waiting for {midSentence(otherName)} to take it.</p>
        ) : result.total === 0 ? (
          <p>{sentByMe ? `All ${chars.length} kanji were new to ${midSentence(otherName)}` : 'All new to you'}</p>
        ) : (
          <p>
            {sentByMe ? `${otherName} got` : 'You got'} <strong>{result.correct} / {result.total}</strong>
            {result.missed.length > 0 && <> — missed <span lang="ja" className="tg-missed-kanji">{[...new Set(result.missed)].join(' ')}</span></>}
            {fresh > 0 && <span className="muted"> · {fresh} new to {sentByMe ? 'them' : 'you'}</span>}
            {skipped > 0 && <span className="muted"> · {skipped} skipped</span>}
          </p>
        )}
      </section>
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
      <TopBar close="/together" heading={false} title={<ProgressBar value={index / items.length} label="Quiz progress" />}
        right={(
          <span className="tg-rp-count" aria-live="polite">
            <span aria-hidden="true">{index + 1} / {items.length}</span>
            <span className="visually-hidden">Kanji {index + 1} of {items.length}</span>
          </span>
        )} />
      <p className="tg-eyebrow">Quiz from {midSentence(fromName)}</p>
      <QuizStep key={index} item={items[index]} onDone={(o) => setOutcomes((prev) => [...prev, o])} />
    </Screen>
  );
}

/** The quiz's kanji, each once (an older server accepted repeats). */
function quizChars(quiz: Quiz): string[] {
  return [...new Set(quiz.items.map((i) => ('char' in i ? i.char : i.key)))];
}

const KIND_NAME: Record<Exclude<Quiz['kind'], 'kanji'>, string> = {
  partner: 'quiz',
  dictation: 'dictation',
  monthly: 'monthly quiz',
};

/** This phone asks a together quiz outside a session: prompt and answer, then the verdict. */
function AskQuiz({ quiz, answererName }: { quiz: Quiz; answererName: string }) {
  const items = quiz.items as PartnerQuizItem[];
  const [verdicts, setVerdicts] = useState<{ key: string; verdict: QuizVerdict }[]>([]);
  const [sending, setSending] = useState<'sending' | ResultDelivery>();
  const submitted = useRef(false);
  const later = useResultDelivery(quiz.id);
  const index = verdicts.length;
  const done = index >= items.length;

  useEffect(() => {
    if (!done || submitted.current) return;
    submitted.current = true;
    setSending('sending');
    finishQuiz(quiz, resultOf(items, verdicts)).then(setSending, () => setSending('failed'));
  }, [done]);

  if (!done) {
    // One verdict per item (the guard in onVerdict): a double tap must not skip the next item.
    return (
      <Screen label="Quiz">
        <TopBar close="/together" title={`${answererName}'s ${KIND_NAME[quiz.kind as keyof typeof KIND_NAME]}`} heading={false} />
        <h1 className="visually-hidden">Ask {answererName}</h1>
        <QuizAsker items={items} index={index} answererName={answererName} kind={quiz.kind as TogetherQuizKind}
          onVerdict={(verdict) => setVerdicts((v) => (v.length === index ? [...v, { key: items[index].key, verdict }] : v))} />
      </Screen>
    );
  }
  const result = resultOf(items, verdicts);
  const status = sending === 'queued' && later && later !== 'queued' ? later : sending;
  return (
    <Screen label="Quiz finished">
      <TopBar close="/together" title="Quiz" heading={false} />
      <section className="tg-quiz-end" aria-labelledby="quiz-score">
        <p className="tg-eyebrow">You asked {midSentence(answererName)}</p>
        <h1 id="quiz-score" className="tg-quiz-score">{result.correct} <span>/ {result.total}</span></h1>
        <p className="tg-sync-status" role="status">
          {status === 'sending' && 'Sending the verdicts…'}
          {status === 'sent' && <><Icon name="check" size={16} />The verdicts reach {midSentence(answererName)}'s reviews when their phone syncs.</>}
          {status === 'queued' && <><Icon name="cloudOff" size={16} />The verdicts go to {midSentence(answererName)} when you reconnect.</>}
          {status === 'failed' && "The verdicts couldn't be sent. The quiz may have been removed."}
        </p>
      </section>
      <Link className="btn secondary block" to="/together">Back to Together</Link>
    </Screen>
  );
}

/** A together quiz seen from the answerer's side (never its answers), or a finished one. */
function TogetherQuizSummary({ quiz, answeredByMe, otherName }: { quiz: Quiz; answeredByMe: boolean; otherName: string }) {
  const items = quiz.items as PartnerQuizItem[];
  const [index, setIndex] = useState(0);
  const result = quiz.result;
  const what = KIND_NAME[quiz.kind as keyof typeof KIND_NAME];
  if (answeredByMe && !result) {
    return (
      <Screen label="Quiz">
        <TopBar back="/together" title={`Your ${what}`} />
        <QuizAnswerer item={items[index]} index={index} total={items.length} askerName={otherName}
          kind={quiz.kind as TogetherQuizKind} />
        <div className="tg-button-row">
          <button type="button" className="btn secondary small" disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</button>
          <button type="button" className="btn secondary small" disabled={index + 1 >= items.length} onClick={() => setIndex(index + 1)}>Next</button>
        </div>
        <p className="muted tg-small">{otherName} asks these on their phone and gives the verdicts.</p>
      </Screen>
    );
  }
  return (
    <Screen label="Quiz">
      <TopBar back="/together" title="Quiz" heading={false} />
      <section className="card tg-quiz-summary" aria-labelledby="quiz-summary-title">
        <h1 id="quiz-summary-title" className="label">
          {answeredByMe ? `Your ${what}, asked by ${midSentence(otherName)}` : `${otherName}'s ${what}`}
        </h1>
        {!result ? (
          <p className="muted">Not asked yet.</p>
        ) : (
          <p>
            {answeredByMe ? 'You got' : `${otherName} got`} <strong>{result.correct} / {result.total}</strong>
            {answeredByMe && <span className="muted"> · cards near their due date count in your reviews</span>}
          </p>
        )}
      </section>
      <Link className="btn secondary block" to="/together">Back to Together</Link>
    </Screen>
  );
}

/** Looks up each kanji and whether this learner has met it, and builds meaning choices. */
async function prepare(quiz: Quiz): Promise<QuizItem[]> {
  const chars = quizChars(quiz);
  const wanted = new Set(chars);
  const [kanji, introducedItems, words] = await Promise.all([
    loadKanji(),
    db.items.where('kind').equals('kanji').primaryKeys(),
    // Only for showing a fitting reading; the quiz still works without it.
    loadWords().then((ws) => ws.filter((w) => wanted.has(w.written)), (): WordEntry[] => []),
  ]);
  const known = introducedItems.map((k) => String(k).slice('kanji:'.length));
  const knownSet = new Set(known);
  const all = Object.values(kanji);
  return chars.map((char) => {
    const entry = kanji[char];
    const introduced = knownSet.has(char);
    if (!entry || !introduced) return { char, entry, introduced, choices: [], reading: '' };
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
    return {
      char, entry, introduced,
      choices: choicesFrom(correct, pool.slice(0, 30), CHOICES, (m) => m.toLowerCase()),
      reading: readingFor(entry, words),
    };
  });
}

function QuizStep({ item, onDone }: { item: QuizItem; onDone(outcome: Outcome): void }) {
  const [stage, setStage] = useState<'meaning' | 'write'>('meaning');
  const [picked, setPicked] = useState<string>();
  const [written, setWritten] = useState<WritingResult>();
  const pad = useRef<WritingPadHandle>(null);
  const { strokes, missing, error } = useStrokes(item.introduced ? item.char : undefined);
  const entry = item.entry;

  // Each step replaces the button that was pressed: keep focus in the quiz.
  const heading = useRef<HTMLHeadingElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useFocusWhenLost(heading, stage);
  useFocusWhenLost(next, Boolean(written));
  useEffect(() => {
    // The choices are switched off once one is picked; go on to what comes next.
    if (picked === undefined) return;
    const button = next.current;
    (button && !button.disabled ? button : feedback.current)?.focus();
  }, [picked]);

  if (!item.introduced || !entry) {
    return (
      <section className="card tg-quiz-card-body tg-new-kanji" aria-labelledby="quiz-new">
        <span className="chip ai">{entry ? 'New to you' : 'Skipped'}</span>
        <div className="tg-quiz-glyph"><Glyph char={item.char} size={96} /></div>
        <h1 ref={heading} id="quiz-new" className="tg-quiz-meaning">
          {entry ? entry.meanings.slice(0, 3).join(', ') : "Not one of Issho's kanji"}
        </h1>
        {entry && (
          <dl className="tg-quiz-readings">
            {entry.kun.length > 0 && <div><dt>Kun</dt><dd lang="ja">{entry.kun.slice(0, 3).join('、')}</dd></div>}
            {entry.on.length > 0 && <div><dt>On</dt><dd lang="ja">{entry.on.slice(0, 3).join('、')}</dd></div>}
          </dl>
        )}
        <p className="muted">
          {entry
            ? "You haven't learned this one yet, so it's skipped. It will come up in your lessons."
            : "Issho doesn't teach this character, so it's skipped."}
        </p>
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
        <h1 ref={heading} id="quiz-q" className="tg-quiz-prompt">What does this kanji mean?</h1>
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
            <div ref={feedback} tabIndex={-1} className={meaningRight ? 'feedback good' : 'feedback bad'} role="status">
              <strong>{meaningRight ? 'Right' : 'Not quite'}</strong>
              <span><span lang="ja">{item.char}</span> means “{entry.meanings.slice(0, 2).join(', ')}”.</span>
            </div>
            <button ref={next} type="button" className="btn ink block" disabled={!noStrokes && !strokes}
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
      <h1 ref={heading} id="quiz-w" className="tg-quiz-prompt">Write it from memory</h1>
      <p className="tg-quiz-target">{correct} <span lang="ja" className="jp-display">{item.reading}</span></p>
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
          <button ref={next} type="button" className="btn ink block" onClick={() => onDone(meaningRight && writtenOk ? 'right' : 'missed')}>
            Next
          </button>
        </>
      )}
    </section>
  );
}

const OUTCOME_LABEL: Record<Outcome, string> = { right: 'Right', missed: 'Missed', new: 'New' };

function QuizEnd({ quiz, items, outcomes, fromName }: {
  quiz: Quiz;
  items: QuizItem[];
  outcomes: Outcome[];
  fromName: string;
}) {
  const total = outcomes.filter((o) => o !== 'new').length;
  const correct = outcomes.filter((o) => o === 'right').length;
  const missed = items.filter((_, i) => outcomes[i] === 'missed').map((i) => i.char);
  const [sending, setSending] = useState<'sending' | ResultDelivery>('sending');
  const submitted = useRef(false);
  // A score that waited offline goes out with the next reconnect; say so when it does.
  const later = useResultDelivery(quiz.id);
  const status = sending === 'queued' && later && later !== 'queued' ? later : sending;
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusWhenLost(heading, 'end');

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    finishQuiz(quiz, { correct, total, missed }).then(setSending, () => setSending('failed'));
  }, [quiz, correct, total, missed]);

  return (
    <Screen label="Quiz finished">
      <TopBar close="/together" title="Quiz" heading={false} />
      <section className="tg-quiz-end" aria-labelledby="quiz-score">
        <p className="tg-eyebrow">Quiz from {midSentence(fromName)}</p>
        {total > 0 ? (
          <h1 ref={heading} id="quiz-score" className="tg-quiz-score">{correct} <span>/ {total}</span></h1>
        ) : (
          <h1 ref={heading} id="quiz-score" className="tg-together-title">All new to you</h1>
        )}
        <p>
          {total === 0 ? `${fromName} is ahead on these. They'll come up in your lessons.`
            : correct === total ? 'Every one. Nicely done.'
              : 'The ones you missed are worth an extra look in your reviews.'}
        </p>
        <ul className="tg-quiz-results">
          {items.map((it, i) => (
            <li key={`${i}-${it.char}`} className={`tg-quiz-result tg-is-${outcomes[i]}`}>
              <Glyph char={it.char} size={34} />
              <span>{outcomes[i] === 'new' && !it.entry ? 'Skipped' : OUTCOME_LABEL[outcomes[i]]}</span>
            </li>
          ))}
        </ul>
        <p className="tg-sync-status" role="status">
          {status === 'sending' && 'Sending your score…'}
          {status === 'sent' && <><Icon name="check" size={16} />{fromName} can see your score now.</>}
          {status === 'queued' && (
            <>
              <Icon name="cloudOff" size={16} />
              {navigator.onLine === false ? "You're offline." : "Your home server isn't answering."}
              {` Your score goes to ${midSentence(fromName)} when you reconnect.`}
            </>
          )}
          {status === 'failed' && "Your score couldn't be sent. The quiz may have been removed."}
        </p>
      </section>
      <Link className="btn secondary block" to="/together">Back to Together</Link>
    </Screen>
  );
}
