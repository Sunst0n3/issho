import { describe, expect, it, vi } from 'vitest';
import type { AiIssue, PartnerQuizItem, TogetherLiveState } from '../../../shared/api.ts';
import type { TogetherWeekPlan } from '../../lib/types.ts';
import { roleOf, runPosition } from './ConversationStage.tsx';
import { lettersLine } from './CoupleQuestCard.tsx';
import { issueRuns } from './DiffText.tsx';
import { endOfMonth } from './MonthlySession.tsx';
import { resultOf, writeCharOf } from './PartnerQuiz.tsx';
import { secondsLeft } from './PlanningTimer.tsx';
import { retellTurn } from './Retell.tsx';
import { comparePosition, joinLive, mergeLive, nextStep, NO_QUIZ, openLive, runPlanOf, sessionSteps } from './session.ts';
import { sessionStatus, sessionToOffer } from './weekPlan.ts';

vi.mock('../../sync/together.ts', () => ({ onLive: () => () => {}, sendLive: () => true }));

describe('session steps', () => {
  it('runs quiz, teach-me and the conversation in Session A', () => {
    expect(sessionSteps('A', { conversation: { scriptId: 'rp-u01', stage: 1 } })).toEqual(['quiz', 'teach-me', 'conversation', 'done']);
    expect(sessionSteps('A', {})).toEqual(['quiz', 'teach-me', 'done']);
  });

  it('runs the task in Session B, or a free role-play without one', () => {
    expect(sessionSteps('B', { task: { unit: 2, taskId: 'u02-task', repeat: false } }))
      .toEqual(['task', 'plan', 'run', 'swap', 'outcome', 'recap', 'done']);
    expect(sessionSteps('B', { rolePlayId: 'rp-cafe' })).toEqual(['roleplay', 'done']);
  });

  it('replaces the dictation with the showcase in Session C when a season finale is due', () => {
    expect(sessionSteps('C', { storyId: 'st-1' })).toEqual(['story', 'retell', 'dictation', 'checkin', 'done']);
    expect(sessionSteps('C', { showcase: true })).toEqual(['retell', 'showcase', 'checkin', 'done']);
  });

  it('runs the monthly quiz, the goal and the capstone when one is due', () => {
    expect(sessionSteps('monthly', { capstoneUnit: 3 })).toEqual(['quiz', 'goal', 'capstone', 'done']);
    expect(sessionSteps('monthly', {})).toEqual(['quiz', 'goal', 'done']);
  });

  it('copies only the shared choices of the week plan', () => {
    const week: TogetherWeekPlan = {
      week: '2026-10-12', sessions: [], settledUnit: 2, monthly: true, showcase: false,
      conversation: { scriptId: 'rp-u03', stage: 2 }, storyId: 'st-1', capstoneUnit: 2,
    };
    expect(runPlanOf(week)).toEqual({ conversation: { scriptId: 'rp-u03', stage: 2 }, storyId: 'st-1', capstoneUnit: 2 });
  });
});

describe('live state', () => {
  const steps = sessionSteps('A', { conversation: { scriptId: 'rp-u01', stage: 3 } });
  const opener = openLive({ sessionId: 's1', session: 'A', me: 'ken', plan: { conversation: { scriptId: 'rp-u01', stage: 3 } }, steps, waiting: true });

  it('lets the joiner take the opener’s plan and position', () => {
    const joined = joinLive({ ...opener, quizIds: { ken: 'q-ken' } });
    expect(joined).toMatchObject({ opener: 'ken', status: 'active', step: 'quiz', plan: { conversation: { scriptId: 'rp-u01', stage: 3 } } });
  });

  it('merges quiz ids from both phones and starts when the partner joins', () => {
    const mine = { ...opener, quizIds: { ken: 'q-ken' } };
    const theirs: TogetherLiveState = { ...joinLive(opener), plan: undefined, quizIds: { me: 'q-me' } };
    const merged = mergeLive(mine, theirs, steps, 'me');
    expect(merged.quizIds).toEqual({ ken: 'q-ken', me: 'q-me' });
    expect(merged.status).toBe('active');
    // The opener's plan stands; the joiner sends none.
    expect(merged.plan).toEqual(opener.plan);
    expect(mergeLive(theirs, { ...mine, quizIds: { ken: NO_QUIZ } }, steps, 'ken').quizIds).toEqual({ me: 'q-me', ken: NO_QUIZ });
  });

  it('only ever moves forward', () => {
    const later: TogetherLiveState = { ...opener, step: 'teach-me', index: 0, turn: 'me' };
    expect(mergeLive(opener, later, steps, 'me')).toMatchObject({ step: 'teach-me', turn: 'me' });
    expect(mergeLive(later, opener, steps, 'ken').step).toBe('teach-me');
    expect(mergeLive(opener, { ...opener, index: 3 }, steps, 'me').index).toBe(3);
    expect(comparePosition(steps, { step: 'conversation', index: 0 }, { step: 'quiz', index: 9 })).toBeGreaterThan(0);
    // Another session is ignored.
    expect(mergeLive(opener, { ...later, sessionId: 's2' }, steps, 'me')).toBe(opener);
    // A heartbeat that changes nothing keeps the same state object.
    expect(mergeLive(later, { ...later, quizIds: { ...later.quizIds } }, steps, 'ken')).toBe(later);
  });

  it('hands the turn over to the partner although the index starts again at 0', () => {
    // Ken (the opener) answered 3 items; my phone asked them and hands the turn to me.
    const kenAnswering: TogetherLiveState = { ...opener, status: 'active', index: 2, turn: 'ken' };
    const meAnswering: TogetherLiveState = { ...kenAnswering, index: 0, turn: 'me' };
    expect(comparePosition(steps, meAnswering, kenAnswering)).toBeGreaterThan(0);
    // Ken's phone takes the hand-over…
    expect(mergeLive(kenAnswering, meAnswering, steps, 'me')).toMatchObject({ step: 'quiz', index: 0, turn: 'me' });
    // …and its older state (a heartbeat sent before it heard) doesn't take it back on mine.
    expect(mergeLive(meAnswering, kenAnswering, steps, 'ken')).toMatchObject({ step: 'quiz', index: 0, turn: 'me' });
    // Within my turn, the index moves on as before.
    expect(mergeLive(meAnswering, { ...meAnswering, index: 1 }, steps, 'ken').index).toBe(1);
    // The next step comes after both turns.
    expect(comparePosition(steps, { ...opener, step: 'teach-me', index: 0 }, { ...meAnswering, index: 9 })).toBeGreaterThan(0);
  });

  it('keeps a phone on its own last step (mark, recap, check-in) when the partner’s phone is done', () => {
    const cases = [
      { session: 'A', plan: { conversation: { scriptId: 'rp-u01', stage: 2 } }, own: 'conversation' },
      { session: 'B', plan: { task: { unit: 2, taskId: 'u02-task', repeat: false } }, own: 'recap' },
      { session: 'C', plan: { storyId: 'st-1' }, own: 'checkin' },
    ] as const;
    for (const { session, plan, own } of cases) {
      const ownSteps = sessionSteps(session, plan);
      const mine: TogetherLiveState = {
        ...openLive({ sessionId: 's1', session, me: 'me', plan, steps: ownSteps, waiting: false }),
        step: own,
        index: 2,
      };
      const theirs: TogetherLiveState = { ...mine, step: 'done', index: 0, status: 'done' };
      // Ken finished first: this phone stays on its step until its own tap (and stops inviting).
      const held = mergeLive(mine, theirs, ownSteps, 'ken');
      expect(held).toMatchObject({ step: own, index: 2, status: 'done' });
      expect(mergeLive(held, theirs, ownSteps, 'ken')).toBe(held);
      expect(nextStep(held, ownSteps)).toMatchObject({ step: 'done', status: 'done' });
      // A phone that is behind still catches up to the own step itself.
      const before = ownSteps[ownSteps.indexOf(own) - 1];
      expect(mergeLive({ ...mine, step: before, index: 0 }, mine, ownSteps, 'ken')).toMatchObject({ step: own, index: 2 });
    }
    // Shared steps follow the partner as before, also on to 'done'.
    const stepsB = sessionSteps('B', { rolePlayId: 'rp-free' });
    const roleplay: TogetherLiveState = { ...opener, session: 'B', status: 'active', step: 'roleplay', index: 3 };
    expect(mergeLive(roleplay, { ...roleplay, step: 'done', index: 0, status: 'done' }, stepsB, 'me'))
      .toMatchObject({ step: 'done', status: 'done' });
  });

  it('shares a timer started on either phone', () => {
    const started = mergeLive(opener, { ...opener, timerStartedAt: 1000 }, steps, 'me');
    expect(started.timerStartedAt).toBe(1000);
  });

  it('resets index, timer and turn on the next step', () => {
    const next = nextStep({ ...opener, status: 'active', index: 4, timerStartedAt: 5, turn: 'me' }, steps);
    expect(next).toMatchObject({ step: 'teach-me', index: 0, turn: 'ken', timerStartedAt: undefined });
    expect(nextStep({ ...next, step: 'conversation' }, steps)).toMatchObject({ step: 'done', status: 'done' });
  });
});

describe('conversation runs', () => {
  it('counts a free run’s position forward across reads (2 lines plus the end card each)', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => runPosition(i, 2, false))).toEqual([
      { run: 0, line: 0 }, { run: 0, line: 1 }, { run: 0, line: 2 },
      { run: 1, line: 0 }, { run: 1, line: 1 }, { run: 1, line: 2 },
      { run: 2, line: 0 },
    ]);
    // Session A runs a stage once.
    expect(runPosition(5, 2, true)).toEqual({ run: 0, line: 2 });
  });

  it('gives the opener role A, or B when roles are swapped', () => {
    expect([roleOf('ken', 'ken', false), roleOf('me', 'ken', false)]).toEqual(['a', 'b']);
    expect([roleOf('ken', 'ken', true), roleOf('me', 'ken', true)]).toEqual(['b', 'a']);
  });
});

describe('quiz helpers', () => {
  const items: PartnerQuizItem[] = [
    { key: 'kanji:水|write', kind: 'write', prompt: 'p', answer: '水' },
    { key: 'core:cw-1|produce', kind: 'produce', prompt: 'p', answer: 'a' },
    { key: 'grammar:te|build', kind: 'build', prompt: 'p', answer: 'a' },
  ];

  it('counts from the verdicts, in quiz order, with a missing verdict as wrong', () => {
    expect(resultOf(items, [{ key: 'grammar:te|build', verdict: 'close' }, { key: 'kanji:水|write', verdict: 'right' }])).toEqual({
      correct: 1,
      total: 3,
      missed: ['core:cw-1|produce', 'grammar:te|build'],
      verdicts: [
        { key: 'kanji:水|write', verdict: 'right' },
        { key: 'core:cw-1|produce', verdict: 'wrong' },
        { key: 'grammar:te|build', verdict: 'close' },
      ],
    });
  });

  it('finds the character a write item asks for', () => {
    expect(writeCharOf(items[0])).toBe('水');
    expect(writeCharOf(items[1])).toBeUndefined();
  });
});

describe('timers', () => {
  it('runs the 4/3/2 retell as 90, 60 and 45 seconds, turns alternating', () => {
    const turns = Array.from({ length: 6 }, (_, i) => retellTurn(i, 'ken', 'me'));
    expect(turns.map((t) => t.seconds)).toEqual([90, 90, 60, 60, 45, 45]);
    expect(turns.map((t) => t.speaker)).toEqual(['ken', 'me', 'ken', 'me', 'ken', 'me']);
  });

  it('counts down from when the timer started', () => {
    expect(secondsLeft(undefined, 90, 5_000)).toBe(90);
    expect(secondsLeft(1_000, 90, 31_000)).toBe(60);
    expect(secondsLeft(1_000, 90, 200_000)).toBe(0);
  });
});

describe('week plan status', () => {
  const plan: TogetherWeekPlan = {
    week: '2026-10-12',
    sessions: [
      { id: 'A', day: '2026-10-13', time: '20:00' },
      { id: 'B', day: '2026-10-15', time: '20:00', doneAt: '2026-10-15' },
      { id: 'C', day: '2026-10-18', time: '19:30' },
      { id: 'monthly', day: '2026-10-17', time: '10:00' },
    ],
    settledUnit: 1, monthly: true, showcase: false,
  };

  it('names each session’s status', () => {
    expect(plan.sessions.map((s) => sessionStatus(s, '2026-10-15'))).toEqual(['overdue', 'done', 'planned', 'planned']);
    // The monthly session spans its weekend.
    expect(sessionStatus(plan.sessions[3], '2026-10-18')).toBe('today');
  });

  it('offers today’s session first, else the earliest one still open', () => {
    expect(sessionToOffer(plan, '2026-10-15')?.id).toBe('A');
    expect(sessionToOffer(plan, '2026-10-18')?.id).toBe('C');
    expect(sessionToOffer({ ...plan, sessions: [] }, '2026-10-15')).toBeUndefined();
  });
});

describe('wording', () => {
  it('says which quest sessions are done', () => {
    expect(lettersLine(new Set(['A', 'B']), 2)).toBe('sessions A and B done, C left');
    expect(lettersLine(new Set(['A', 'B', 'C']), 3)).toBe('sessions A, B and C done');
    expect(lettersLine(new Set(), 0)).toBe('no sessions yet');
    expect(lettersLine(new Set(['monthly']), 1)).toBe('the monthly session done');
    // The monthly session stands in for one letter: only one more is needed.
    expect(lettersLine(new Set(['A', 'monthly']), 2)).toBe('sessions A and the monthly done, B or C left');
    expect(lettersLine(new Set(['A', 'C', 'monthly']), 3)).toBe('three sessions done');
  });

  it('finds the end of the month', () => {
    expect(endOfMonth('2026-11-07')).toBe('2026-11-30');
    expect(endOfMonth('2028-02-05')).toBe('2028-02-29');
  });

  it('splits a text into issue spans, skipping unlocated and overlapping ones', () => {
    const issue = (start: number | null, end: number | null): AiIssue => ({ quote: '', start, end, type: 'particle', uncertain: false, hint: '' });
    expect(issueRuns('駅で行く', [issue(1, 2), issue(null, null), issue(1, 3)])).toEqual([
      { text: '駅' },
      { text: 'で', issue: 1 },
      { text: '行く' },
    ]);
  });
});
