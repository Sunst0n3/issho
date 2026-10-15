// The partner quiz (Session A), dictation (Session C) and the monthly quiz: one partner answers
// out loud, on the WritingPad or on paper; the other holds the prompt and the answer and gives
// the verdict. The answerer's own cards are what is asked, so the verdicts feed the answerer's
// reviews (applied on the answerer's phone, only for cards near their due date).

import { useEffect, useId, useRef, useState } from 'react';
import type { PartnerQuizItem, Quiz, QuizItemVerdict, QuizVerdict } from '../../../shared/api.ts';
import { loadKanji } from '../../lib/data.ts';
import { itemIdOfCard, parseItemId } from '../../lib/db.ts';
import { applyLocalVerdicts, buildQuizPool } from '../../srs/together.ts';
import { createQuiz } from '../../sync/client.ts';
import { uuid } from '../../sync/outbox.ts';
import { useStrokes } from '../../writing/useStrokes.ts';
import { WritingPad } from '../../writing/WritingPad.tsx';
import { Icon, ProgressBar, Ruby } from '../ui.tsx';
import { midSentence } from './household.ts';
import { finishQuiz, refreshQuizzes, rememberQuiz, useQuizzes } from './quizzes.ts';
import { NO_QUIZ, type LiveRun } from './session.ts';

export type TogetherQuizKind = 'partner' | 'dictation' | 'monthly';

export interface QuizPerson {
  id: string;
  name: string;
}

const KIND_HINT: Record<PartnerQuizItem['kind'], string> = {
  write: 'Write it',
  read: 'Read it aloud',
  produce: 'Say it in Japanese',
  build: 'Make the sentence',
};

const VERDICTS: { verdict: QuizVerdict; label: string; className: string }[] = [
  { verdict: 'right', label: 'Right', className: 'btn primary' },
  { verdict: 'close', label: 'Close', className: 'btn secondary' },
  { verdict: 'wrong', label: 'Not yet', className: 'btn ghost' },
];

/** The kanji a write item asks for ('kanji:水|write' → '水'), if it is one. */
export function writeCharOf(item: Pick<PartnerQuizItem, 'key' | 'kind'>): string | undefined {
  if (item.kind !== 'write') return undefined;
  const parsed = parseItemId(itemIdOfCard(item.key));
  return parsed?.kind === 'kanji' || parsed?.kind === 'kana' ? parsed.key : undefined;
}

/** The result a list of verdicts makes (correct = right, missed = everything else). */
export function resultOf(items: readonly PartnerQuizItem[], verdicts: readonly QuizItemVerdict[]) {
  const byKey = new Map(verdicts.map((v) => [v.key, v.verdict]));
  const ordered = items.map((item) => ({ key: item.key, verdict: byKey.get(item.key) ?? 'wrong' }));
  return {
    correct: ordered.filter((v) => v.verdict === 'right').length,
    total: items.length,
    missed: ordered.filter((v) => v.verdict !== 'right').map((v) => v.key),
    verdicts: ordered,
  };
}

// ---- The two views ---------------------------------------------------------------------

/** The asker's phone: the prompt and the answer, and the three verdicts. */
export function QuizAsker({ items, index, answererName, kind, onVerdict }: {
  items: readonly PartnerQuizItem[];
  index: number;
  answererName: string;
  kind: TogetherQuizKind;
  onVerdict(verdict: QuizVerdict): void;
}) {
  const id = useId();
  const item = items[Math.min(index, items.length - 1)];
  if (!item) return null;
  return (
    <section className="card tg-quiz-asker" aria-labelledby={`${id}-head`}>
      <ProgressBar value={index / items.length} label="Quiz progress" />
      <p className="label" id={`${id}-head`}>
        You ask {midSentence(answererName)} · {index + 1} of {items.length}
      </p>
      <p className="tg-quiz-instruction">
        {kind === 'dictation' ? 'Read the word aloud. They write it in kanji.' : `${KIND_HINT[item.kind]}: read this out.`}
      </p>
      <p className="tg-quiz-prompt"><Ruby text={item.prompt} show="all" /></p>
      <div className="tg-quiz-answer">
        <span className="label">Answer</span>
        <span className="tg-quiz-answer-text" lang="ja"><Ruby text={item.answer} show="all" /></span>
      </div>
      <div className="tg-verdicts" role="group" aria-label="How did they do?">
        {VERDICTS.map((v) => (
          <button key={v.verdict} type="button" className={`${v.className} small`} onClick={() => onVerdict(v.verdict)}>
            {v.verdict === 'right' && <Icon name="check" size={16} />}
            {v.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** The answerer's phone: never the answer. A pad for writing items; paper is fine too. */
export function QuizAnswerer({ item, index, total, askerName }: {
  item?: PartnerQuizItem;
  index: number;
  total: number;
  askerName: string;
}) {
  const char = item ? writeCharOf(item) : undefined;
  return (
    <section className="card tg-quiz-answerer" aria-live="polite">
      <ProgressBar value={total ? index / total : 0} label="Quiz progress" />
      <p className="label">{total ? `${Math.min(index + 1, total)} of ${total}` : 'Your turn'}</p>
      <h2 className="tg-quiz-turn">Your turn: answer out loud or write</h2>
      <p className="muted">
        {item ? `${KIND_HINT[item.kind]}. ` : ''}{askerName} has the question and the answer.
      </p>
      {char && <AnswerPad key={`${index}:${char}`} char={char} />}
    </section>
  );
}

function AnswerPad({ char }: { char: string }) {
  const strokes = useStrokes(char);
  const [done, setDone] = useState(false);
  if (!strokes.strokes) return <p className="muted tg-small">Write it on paper.</p>;
  return (
    <div className="tg-quiz-pad">
      <WritingPad strokes={strokes.strokes} mode="recall" label="your answer" doneLabel="Show me"
        onRecallDone={() => setDone(true)} />
      <p className="muted tg-small">{done ? 'Compare with the model, then wait for the verdict.' : 'Or write it on paper.'}</p>
    </div>
  );
}

// ---- One quiz step in a session -------------------------------------------------------

interface Direction {
  /** Who answers. */
  answerer: QuizPerson;
  /** Items this phone shows; undefined while loading. */
  items?: PartnerQuizItem[];
  /** A server quiz whose verdicts are posted (duo, or the partner's waiting quiz in pass-and-play). */
  quiz?: Quiz;
  /** Pass-and-play, the owner answers: verdicts applied on this phone at once. */
  local?: boolean;
  /** Pass-and-play, the partner answers with no quiz of theirs here: practice only, nothing recorded. */
  practice?: boolean;
}

/**
 * Runs both directions of a together quiz. Duo: each phone posts its own pool as a quiz for the
 * partner to ask; the live state's `turn` is the answerer and `index` the item. Pass-and-play: the
 * owner's pool first (the partner holds the phone), then the partner's newest waiting quiz, else a
 * practice round from their recent kanji, else nothing.
 */
export function PartnerQuizStep({ kind, duo, me, partner, partnerRecentKanji, run, online }: {
  kind: TogetherQuizKind;
  duo: boolean;
  me: QuizPerson;
  partner: QuizPerson;
  partnerRecentKanji: readonly string[];
  run: LiveRun;
  online: boolean;
}) {
  const { live, update, next } = run;
  const quizzes = useQuizzes();
  const [myItems, setMyItems] = useState<PartnerQuizItem[]>();
  const [notice, setNotice] = useState<string>();
  const verdicts = useRef(new Map<string, QuizVerdict>());
  /** Directions (by answerer) already finished here: a double tap on the last verdict counts once. */
  const finished = useRef(new Set<string>());
  /** Directions whose last verdict is being saved. */
  const closing = useRef(new Set<string>());
  /** The owner's pass-and-play verdicts are applied under one local quiz id, so they apply once. */
  const [localQuizId] = useState(() => `local-${uuid()}`);
  const started = useRef(false);
  const turn = live.turn ?? live.opener;
  const iAnswer = turn === me.id;
  const index = live.index ?? 0;

  // Build this phone's pool once (and post it in duo).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      let items: PartnerQuizItem[] = [];
      try {
        items = await buildQuizPool(kind);
      } catch {
        items = [];
      }
      setMyItems(items);
      if (!duo || live.quizIds?.[me.id]) return;
      if (!items.length) {
        update((s) => ({ ...s, quizIds: { ...s.quizIds, [me.id]: NO_QUIZ } }));
        return;
      }
      try {
        const quiz = await createQuiz({ toMemberId: partner.id, kind, items });
        await rememberQuiz(quiz);
        update((s) => ({ ...s, quizIds: { ...s.quizIds, [me.id]: quiz.id } }));
      } catch {
        setNotice("Your quiz couldn't reach the home server. This round is practice only.");
        update((s) => ({ ...s, quizIds: { ...s.quizIds, [me.id]: NO_QUIZ } }));
      }
    })();
  }, []);

  // A new direction starts with fresh verdicts.
  useEffect(() => { verdicts.current = new Map(); }, [turn]);

  const partnerQuizId = live.quizIds?.[partner.id];
  const serverQuiz = partnerQuizId && partnerQuizId !== NO_QUIZ
    ? quizzes.data?.inbox.find((q) => q.id === partnerQuizId)
    : undefined;
  useEffect(() => {
    if (duo && partnerQuizId && partnerQuizId !== NO_QUIZ && !serverQuiz) void refreshQuizzes();
  }, [duo, partnerQuizId, serverQuiz]);

  const waitingQuiz = !duo
    ? quizzes.data?.inbox
      .filter((q) => q.kind === kind && q.fromMemberId === partner.id && !q.result)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : undefined;
  const [practice, setPractice] = useState<PartnerQuizItem[]>();
  useEffect(() => {
    if (duo || waitingQuiz || !partnerRecentKanji.length) return;
    let live = true;
    void practiceItems(partnerRecentKanji, kind).then((items) => { if (live) setPractice(items); });
    return () => { live = false; };
  }, [duo, Boolean(waitingQuiz), partnerRecentKanji.join(''), kind]);

  const direction: Direction = iAnswer
    ? { answerer: me, items: myItems, local: !duo }
    : duo
      ? {
          answerer: partner,
          items: partnerQuizId === NO_QUIZ ? [] : (serverQuiz?.items as PartnerQuizItem[] | undefined),
          quiz: serverQuiz,
        }
      : waitingQuiz
        ? { answerer: partner, items: waitingQuiz.items as PartnerQuizItem[], quiz: waitingQuiz }
        : { answerer: partner, items: practice ?? [], practice: true };

  /**
   * The direction answered by `answerer` is over: after the first one the turn passes to the other
   * partner, after the second the session moves on. Once per direction, so a double tap can't
   * skip a step.
   */
  const finishDirection = (answerer: string = turn) => {
    if (finished.current.has(answerer)) return;
    finished.current.add(answerer);
    if (answerer === live.opener) update((s) => ({ ...s, turn: s.opener === me.id ? partner.id : me.id, index: 0 }));
    else next();
  };

  const onVerdict = async (items: PartnerQuizItem[], verdict: QuizVerdict) => {
    const answerer = turn;
    const item = items[index];
    if (!item || closing.current.has(answerer)) return;
    verdicts.current.set(item.key, verdict);
    if (index + 1 < items.length) {
      update((s) => ({ ...s, index: index + 1 }));
      return;
    }
    // The last verdict: record the direction once, whatever else is tapped while it saves.
    closing.current.add(answerer);
    const result = resultOf(items, [...verdicts.current].map(([key, v]) => ({ key, verdict: v })));
    try {
      if (direction.local) await applyLocalVerdicts(localQuizId, items, result.verdicts);
      else if (direction.quiz) await finishQuiz(direction.quiz, result);
    } catch {
      setNotice("Those verdicts couldn't be saved. They don't count this time.");
    }
    finishDirection(answerer);
  };

  // ---- Views ----
  if (iAnswer && duo) {
    // The partner's phone asks; this one only answers.
    if (!myItems) return <div className="tg-skeleton-block" aria-busy="true" aria-label="Getting your quiz ready" />;
    if (!myItems.length) {
      return (
        <section className="card" role="status">
          <h2>Nothing to quiz you on yet</h2>
          <p className="muted">Words and kanji join the quiz 2 days after you learn them.</p>
          <button type="button" className="btn secondary small" onClick={() => finishDirection()}>Swap</button>
        </section>
      );
    }
    return (
      <>
        <QuizAnswerer item={myItems[index]} index={index} total={myItems.length} askerName={partner.name} />
        {notice && <p className="tg-composer-notice" role="status">{notice}</p>}
      </>
    );
  }

  const asking = direction.answerer;
  if (duo && !iAnswer && !partnerQuizId) {
    return (
      <section className="card" role="status">
        <span className="tg-pulse" aria-hidden="true" />
        <p>Waiting for {midSentence(partner.name)}'s quiz…</p>
      </section>
    );
  }
  if (!direction.items) {
    return <div className="tg-skeleton-block" aria-busy="true" aria-label="Getting the quiz ready" />;
  }
  if (!direction.items.length) {
    return (
      <section className="card" role="status">
        <h2>{asking.id === me.id ? 'Nothing to quiz you on yet' : `Nothing to ask ${midSentence(asking.name)} this time`}</h2>
        <p className="muted">
          {asking.id === me.id
            ? 'Words and kanji join the quiz 2 days after you learn them.'
            : online ? 'Their phone has nothing waiting for this quiz.' : "Their quiz comes through the home server, and you're offline."}
        </p>
        <button type="button" className="btn secondary small" onClick={() => finishDirection()}>
          {turn === live.opener ? 'Swap' : 'Continue'}
        </button>
      </section>
    );
  }

  return (
    <>
      {!duo && (
        <p className="tg-pass-note" role="status">
          {asking.id === me.id
            ? `Hand the phone to ${partner.name}: they ask, you answer.`
            : `Take the phone back: you ask ${partner.name}.`}
          {direction.practice && ' Practice round: it only counts for fun.'}
        </p>
      )}
      <QuizAsker items={direction.items} index={index} answererName={asking.name} kind={kind}
        onVerdict={(v) => void onVerdict(direction.items!, v)} />
      {notice && <p className="tg-composer-notice" role="status">{notice}</p>}
    </>
  );
}

/** Pass-and-play without a quiz from the partner: their recent kanji to write, practice only. */
async function practiceItems(chars: readonly string[], kind: TogetherQuizKind): Promise<PartnerQuizItem[]> {
  const kanji = await loadKanji().catch(() => ({} as Record<string, { meanings: string[] }>));
  const max = kind === 'dictation' ? 5 : kind === 'monthly' ? 20 : 10;
  return chars.slice(0, max).map((char) => ({
    key: `kanji:${char}|write`,
    kind: 'write' as const,
    prompt: `Write the kanji for "${kanji[char]?.meanings[0] ?? '?'}"`,
    answer: char,
  }));
}
