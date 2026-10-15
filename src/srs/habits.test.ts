import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings } from '../lib/db.ts';
import type { DayRecord } from '../lib/types.ts';
import { addDays, emptyDay, getDay, updateDay } from './days.ts';
import {
  cancelPlannedToken,
  chooseFreshStart,
  comeback,
  comebackOffer,
  completeDay,
  completeMakeup,
  completeMicro,
  creditTogetherSession,
  firstStudyDay,
  noteReviewProgress,
  planReviewDays,
  REPAIR_MIN_MS,
  repairDeadline,
  setTravel,
  spendRestToken,
  streak,
  streakFromHabitDays,
  type HabitDay,
} from './habits.ts';
import { introduceItem, markKnownMany } from './items.ts';
import { gradeCard, newCardRecord } from './scheduler.ts';
import { at, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const habit = (date: string, patch: Partial<HabitDay> = {}): HabitDay => ({
  date, minimumDone: false, goalMet: false, token: false, repaired: false, travel: false, ...patch,
});
const studied = (date: string, goal = true) => habit(date, { minimumDone: true, goalMet: goal });

async function studyDay(date: string, patch: Partial<DayRecord> = {}): Promise<void> {
  await db.days.put({ ...emptyDay(date), reviews: 10, studyMs: 1_500_000, minimumDone: true, goalMet: true, ...patch });
}

describe('streakFromHabitDays', () => {
  const now = at(2026, 3, 20, 9); // Friday

  it('keeps the run over a token day, adds nothing for it, and never breaks on today', () => {
    const days = [studied('2026-03-16'), habit('2026-03-17', { token: true }), studied('2026-03-18'), studied('2026-03-19')];
    const s = streakFromHabitDays(days, '2026-03-20', '2026-03-16', now);
    expect(s).toMatchObject({ current: 3, alive: true, longest: 3, todayMinimum: false, tokensLeftThisWeek: 1 });
    expect(s.week.map((d) => d.status)).toEqual(['goal', 'rest', 'goal', 'goal', 'today', 'future', 'future']);
  });

  it('breaks on an uncovered missed day: a broken streak is not alive', () => {
    const days = [studied('2026-03-16'), studied('2026-03-17')];
    const s = streakFromHabitDays(days, '2026-03-20', '2026-03-16', now);
    expect(s.current).toBe(0);
    expect(s.alive).toBe(false);
    expect(s.longest).toBe(2);
    expect(s.week.map((d) => d.status).slice(0, 5)).toEqual(['goal', 'goal', 'missed', 'missed', 'today']);
  });

  it('is alive on the very first day', () => {
    expect(streakFromHabitDays([], '2026-03-20', '2026-03-20', now)).toMatchObject({ current: 0, alive: true });
  });

  it('counts a minimum day for the streak while today’s goal stays false', () => {
    const s = streakFromHabitDays([studied('2026-03-19'), habit('2026-03-20', { minimumDone: true })], '2026-03-20', '2026-03-19', now);
    expect(s).toMatchObject({ current: 2, todayMinimum: true, todayGoal: false });
    expect(s.week[4].status).toBe('done');
  });

  it('freezes on travel days: they neither break nor add', () => {
    const days = [studied('2026-03-16'), habit('2026-03-17', { travel: true }), habit('2026-03-18', { travel: true }), studied('2026-03-19')];
    const s = streakFromHabitDays(days, '2026-03-20', '2026-03-16', now);
    expect(s.current).toBe(2);
    expect(s.week[1].status).toBe('travel');
  });

  it('counts the days studied this month', () => {
    const days = [studied('2026-02-28'), studied('2026-03-01'), studied('2026-03-02', false), habit('2026-03-03', { token: true })];
    expect(streakFromHabitDays(days, '2026-03-20', '2026-02-28', now).daysThisMonth).toBe(2);
  });

  it('offers a token for yesterday only when it was missed and its week has one left', () => {
    expect(streakFromHabitDays([studied('2026-03-18')], '2026-03-20', '2026-03-18', now).offerTokenFor).toBe('2026-03-19');
    expect(streakFromHabitDays([studied('2026-03-19')], '2026-03-20', '2026-03-18', now).offerTokenFor).toBeUndefined();
    const spent = [studied('2026-03-16'), habit('2026-03-17', { token: true }), habit('2026-03-18', { token: true })];
    const s = streakFromHabitDays(spent, '2026-03-20', '2026-03-16', now);
    expect(s.offerTokenFor).toBeUndefined();
    expect(s.repairable).toEqual({ date: '2026-03-19', deadline: repairDeadline('2026-03-19') });
  });

  it('offers no token for yesterday when it is not the gap’s only missed day: a token could not keep the run (V004)', () => {
    // Six days missed, Saturday the 14th to Thursday the 19th, with tokens left this week.
    const s = streakFromHabitDays([studied('2026-03-13')], '2026-03-20', '2026-03-13', now);
    expect(s.tokensLeftThisWeek).toBe(2);
    expect(s.offerTokenFor).toBeUndefined();
    // One day missed: the token keeps the run.
    expect(streakFromHabitDays([studied('2026-03-13'), studied('2026-03-18')], '2026-03-20', '2026-03-13', now).offerTokenFor).toBe('2026-03-19');
    // A token day inside the gap is covered: yesterday is still the only missed day.
    const covered = [studied('2026-03-16'), habit('2026-03-17', { token: true }), studied('2026-03-18')];
    expect(streakFromHabitDays(covered, '2026-03-20', '2026-03-16', now).offerTokenFor).toBe('2026-03-19');
  });

  it('offers no make-up after a 3-day gap with the tokens used: the oldest day is past repair (V004)', () => {
    // Week of the 16th: tokens on Mon and Tue already spent elsewhere; Wed, Thu and Fri missed; today Saturday.
    const saturday = at(2026, 3, 21, 20);
    const days = [
      studied('2026-03-15'), habit('2026-03-16', { token: true }), habit('2026-03-17', { token: true }),
      habit('2026-03-21', { minimumDone: true, goalMet: true }),
    ];
    const gap3 = streakFromHabitDays(days.filter((d) => d.date !== '2026-03-17'), '2026-03-21', '2026-03-15', saturday);
    expect(gap3.offerTokenFor).toBeUndefined();
    const spent = streakFromHabitDays([...days, habit('2026-03-18', { minimumDone: false })], '2026-03-21', '2026-03-15', saturday);
    expect(spent.repairable).toBeUndefined();
    expect(spent.makeupOffer).toBe(false);
    // Two missed days, both within their 48 hours: the make-up is offered.
    const twoDays = [...days, studied('2026-03-18')];
    const s = streakFromHabitDays(twoDays, '2026-03-21', '2026-03-15', saturday);
    expect(s.repairable?.date).toBe('2026-03-20');
    expect(s.makeupOffer).toBe(true);
  });

  it('has no repairable day while the missed day’s week still has a token', () => {
    const s = streakFromHabitDays([studied('2026-03-18')], '2026-03-20', '2026-03-18', now);
    expect(s.repairable).toBeUndefined();
    expect(s.makeupOffer).toBe(false);
  });
});

describe('rest tokens', () => {
  const now = at(2026, 3, 20, 9);

  it('covers a missed day; the third token in an ISO week is refused', async () => {
    await studyDay('2026-03-16');
    expect(await spendRestToken('2026-03-17', now)).toBe('ok');
    expect(await spendRestToken('2026-03-17', now)).toBe('already');
    expect(await spendRestToken('2026-03-18', now)).toBe('ok');
    expect(await spendRestToken('2026-03-19', now)).toBe('none-left');
    await studyDay('2026-03-19');
    expect((await streak(now)).current).toBe(2);
  });

  it('plans a future day, cancels it, and never covers today or a studied day', async () => {
    await studyDay('2026-03-19');
    expect(await spendRestToken('2026-03-20', now)).toBe('not-allowed');
    expect(await spendRestToken('2026-03-19', now)).toBe('not-allowed');
    expect(await spendRestToken('2026-03-24', now)).toBe('ok');
    await cancelPlannedToken('2026-03-24', now);
    expect(await db.restTokens.count()).toBe(0);
    expect(await spendRestToken('2026-02-01', now)).toBe('not-allowed');
  });
});

describe('repair', () => {
  // Week of Monday 2026-03-16: tokens on Tue and Wed, Thursday the 19th missed.
  async function setup() {
    await studyDay('2026-03-12');
    await studyDay('2026-03-13');
    await studyDay('2026-03-16');
    await db.restTokens.bulkPut([
      { date: '2026-03-17', week: '2026-03-16', usedAt: at(2026, 3, 18) },
      { date: '2026-03-18', week: '2026-03-16', usedAt: at(2026, 3, 19) },
    ]);
  }

  it('one normal session the next day does not repair the missed day', async () => {
    await setup();
    const now = at(2026, 3, 20, 20);
    const s = await completeDay(now);
    expect(s.repairable?.date).toBe('2026-03-19');
    expect(s.makeupOffer).toBe(true);
    expect(await completeMakeup(now)).toBe(false);
    expect((await getDay('2026-03-19')).repaired).toBeUndefined();
    expect(s.current).toBe(1);
  });

  it('offers the make-up only after today’s goal is met', async () => {
    await setup();
    const now = at(2026, 3, 20, 9);
    expect((await streak(now)).makeupOffer).toBe(false);
    await completeMicro(now);
    expect((await streak(now)).makeupOffer).toBe(false);
    await completeDay(now);
    expect((await streak(now)).makeupOffer).toBe(true);
  });

  it('a 10-minute make-up within 48 hours repairs the day, once', async () => {
    await setup();
    // 47 h 59 min after 4 a.m. on the 20th: still the study day of the 21st.
    const now = new Date(at(2026, 3, 20, 4).getTime() + (47 * 60 + 59) * 60_000);
    await studyDay('2026-03-20');
    await studyDay('2026-03-21', { makeupMs: REPAIR_MIN_MS });
    expect(await completeMakeup(now)).toBe(true);
    expect((await getDay('2026-03-19')).repaired).toBe(true);
    expect(await completeMakeup(now)).toBe(false);
    const s = await streak(now);
    expect(s.week[3].status).toBe('repaired');
    expect(s.current).toBe(3); // 16th, 20th and 21st; the 14th–15th weekend broke the earlier run
  });

  it('refuses a make-up after 48 hours, or one shorter than 10 minutes', async () => {
    await setup();
    await studyDay('2026-03-20');
    await studyDay('2026-03-21');
    await studyDay('2026-03-22', { makeupMs: REPAIR_MIN_MS });
    const late = new Date(at(2026, 3, 20, 4).getTime() + 49 * 3_600_000);
    expect(await completeMakeup(late)).toBe(false);

    await resetDb();
    await setup();
    await studyDay('2026-03-20', { makeupMs: 9 * 60_000 });
    expect(await completeMakeup(at(2026, 3, 20, 20))).toBe(false);
    expect((await getDay('2026-03-19')).repaired).toBeUndefined();
  });
});

describe('minimum days', () => {
  const now = at(2026, 3, 20, 9);

  it('counts the minimum once only New cards and today’s items are left due', async () => {
    await introduceItem('word', '1', at(2026, 3, 10));
    const old = (await db.cards.get('word:1|read'))!;
    await db.cards.put({ ...old, state: State.Review, stability: 3, difficulty: 5, reps: 2, last_review: at(2026, 3, 15), due: at(2026, 3, 19) });
    await introduceItem('word', '2', now); // today's item: its New card is due
    await db.cards.put({ ...newCardRecord('word:3', 'word', 'read', at(2026, 3, 1)), state: State.Review, stability: 3, reps: 2, last_review: at(2026, 3, 10), due: at(2026, 3, 21, 4) }); // buried
    await db.items.put({ id: 'word:3', kind: 'word', key: '3', introducedAt: at(2026, 3, 1) });
    expect(await noteReviewProgress(now)).toBe(false);
    await gradeCard('word:1|read', Rating.Good, { durationMs: 5000, mode: 'typed', now });
    expect(await noteReviewProgress(now)).toBe(true);
    expect((await getDay('2026-03-20')).minimumDone).toBe(true);
  });

  it('counts the minimum after 5 minutes of reviews', async () => {
    await updateDay('2026-03-20', (d) => {
      d.reviews = 30;
      d.reviewMs = 5 * 60_000;
    });
    await introduceItem('word', '1', at(2026, 3, 10));
    const card = (await db.cards.get('word:1|read'))!;
    await db.cards.put({ ...card, state: State.Review, due: at(2026, 3, 19), last_review: at(2026, 3, 15), stability: 3 });
    expect(await noteReviewProgress(now)).toBe(true);
  });

  it('completes a day idempotently', async () => {
    const first = await completeDay(now);
    const second = await completeDay(now);
    expect(second).toEqual(first);
    expect(await getDay('2026-03-20')).toMatchObject({ minimumDone: true, goalMet: true });
  });
});

describe('together sessions', () => {
  it('credits a session once per date', async () => {
    const now = at(2026, 3, 20, 21);
    expect(await creditTogetherSession('A', 15, '2026-03-20', now)).toBe(true);
    expect(await creditTogetherSession('A', 15, '2026-03-20', now)).toBe(false);
    expect(await creditTogetherSession('B', 10, '2026-03-20', now)).toBe(true);
    const day = await getDay('2026-03-20');
    expect(day).toMatchObject({ togetherMs: 25 * 60_000, minimumDone: true, together: ['A', 'B'] });
  });
});

describe('comeback', () => {
  it('offers a welcome-back after a missed day and a fresh start after 3', () => {
    const days = [studied('2026-03-10'), studied('2026-03-18')];
    expect(comebackOffer(days, '2026-03-20')).toEqual({ kind: 'welcome-back', missedDays: 1 });
    expect(comebackOffer([studied('2026-03-10'), studied('2026-03-19')], '2026-03-20')).toEqual({ kind: 'none', missedDays: 0 });
    // A 5-day gap, today Friday the 20th: next Monday (23rd) comes before April 1st.
    expect(comebackOffer([studied('2026-03-14')], '2026-03-20')).toEqual({ kind: 'fresh-start', missedDays: 5, freshStart: '2026-03-23' });
    // Today Monday the 28th of September: the 1st of October comes before next Monday.
    expect(comebackOffer([studied('2026-09-20')], '2026-09-28').freshStart).toBe('2026-10-01');
  });

  it('does not count travel and token days as missed', () => {
    const days = [studied('2026-03-14'), habit('2026-03-15', { travel: true }), habit('2026-03-16', { travel: true }), habit('2026-03-17', { travel: true }), habit('2026-03-18', { token: true }), studied('2026-03-19')];
    expect(comebackOffer(days, '2026-03-20').kind).toBe('none');
    expect(comebackOffer(days.slice(0, 5), '2026-03-20')).toEqual({ kind: 'welcome-back', missedDays: 1 });
  });

  it('does not start the run on the evening of a placement check: the first session is day one', async () => {
    // Onboarding on Thursday evening passed the hiragana check (items via 'placement'); the first session is Friday.
    await markKnownMany([{ kind: 'kana', key: 'あ' }, { kind: 'kana', key: 'い' }], at(2026, 3, 19, 21));
    const now = at(2026, 3, 20, 9);
    expect(await firstStudyDay(now)).toBe('2026-03-20');
    const s = await streak(now);
    expect(s.offerTokenFor).toBeUndefined();
    expect(s.week.find((d) => d.date === '2026-03-19')?.status).toBe('before');
    expect(s.alive).toBe(true);
    expect(await comeback(now)).toEqual({ kind: 'none', missedDays: 0 });
    // An item introduced by studying does count.
    await introduceItem('kana', 'う', at(2026, 3, 19, 21));
    expect(await firstStudyDay(now)).toBe('2026-03-19');
  });

  it('saves the fresh start and plans review days', async () => {
    await chooseFreshStart('2026-03-23');
    expect((await getSettings()).freshStart).toBe('2026-03-23');
    expect(planReviewDays('2026-03-01')).toEqual(['2026-03-29', '2026-04-26']);
  });
});

describe('travel', () => {
  it('marks the days inside and clears the rest when travel ends early', async () => {
    const now = at(2026, 3, 20, 9);
    await studyDay('2026-03-19');
    await setTravel('2026-03-24', now);
    expect((await getSettings()).travelUntil).toBe('2026-03-24');
    for (let d = '2026-03-20'; d <= '2026-03-24'; d = addDays(d, 1)) expect((await getDay(d)).travel).toBe(true);
    await setTravel(null, at(2026, 3, 22, 9));
    expect((await getSettings()).travelUntil).toBeUndefined();
    expect((await getDay('2026-03-21')).travel).toBe(true);
    expect((await getDay('2026-03-23')).travel).toBeUndefined();
    expect((await getDay('2026-03-22')).travel).toBeUndefined();
    const s = await streak(at(2026, 3, 22, 9));
    expect(s.week.find((d) => d.date === '2026-03-21')?.status).toBe('travel');
  });
});
