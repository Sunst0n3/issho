// Integration (design §5.2 tests 2 and 3b): the session screen on the real engine — planner, course, scheduler,
// habits, reading, output and the card guard — with the engine's fixture course as data. Only audio, handwriting
// recognition, speech, stats upload and the home server's AI are stand-ins. A small autopilot answers whatever the
// screen asks, the way a learner would, so the test follows the plan the engine makes rather than a scripted one.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Rating, State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCheckRequest, AiCheckResponse } from '../../../shared/api.ts';
import { dayKey, db, DEFAULT_SETTINGS } from '../../lib/db.ts';
import type { CoreWord, CurriculumUnit, KanjiEntry, SentenceEntry, WordEntry } from '../../lib/types.ts';
import Session from '../../screens/Session.tsx';
import { introducePlanItem } from '../../srs/course.ts';
import { completeDay } from '../../srs/habits.ts';
import { planToday, startSitting } from '../../srs/planner.ts';
import { gradeCard } from '../../srs/scheduler.ts';
import { at, CORE, CURRICULUM, fixtures, GRAMMAR, KANJI, resetDb, WORDS } from '../../srs/test-fixtures.ts';
import { aiCheck } from '../../sync/client.ts';
import { flushPendingOutputChecks } from '../../sync/together.ts';

vi.mock('../../lib/data.ts', async () => {
  const { dataMock } = await import('../../srs/test-fixtures.ts');
  // Every character has a stroke, so the (stand-in) writing pad is used rather than paper.
  return { ...dataMock, strokesFor: async () => ['M10 10L90 90'] };
});
vi.mock('../../writing/WritingPad.tsx', async () => (await import('./test-utils.tsx')).writingPadMock);
vi.mock('../../speech/audio.ts', async () => (await import('./test-utils.tsx')).audioMock);
vi.mock('../../speech/recognition.ts', () => ({ recognitionAvailable: () => false, listen: vi.fn() }));
vi.mock('../../speech/recorder.ts', () => ({ micAvailable: () => false }));
vi.mock('../../sync/stats.ts', () => ({ pushStats: vi.fn(async () => true), useHousehold: () => ({ loading: false, refresh: async () => {} }) }));
vi.mock('../../sync/client.ts', async (original) => ({
  ...(await original<typeof import('../../sync/client.ts')>()),
  aiCheck: vi.fn(),
  // The home server's checker is on: flushPendingOutputChecks asks before it sends a queued check.
  aiStatus: vi.fn(async () => 'on' as const),
  aiReport: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// The course up to a given day, studied in full every day (as in the engine's own integration test)
// ---------------------------------------------------------------------------

/** The engine's fixture course runs out of kanji and core words by about course day 18: these keep it going. */
const MORE_KANJI: [char: string, kana: string, en: string][] = [
  ['山', 'やま', 'mountain'], ['川', 'かわ', 'river'], ['田', 'た', 'rice field'], ['木', 'き', 'tree'], ['火', 'ひ', 'fire'],
  ['水', 'みず', 'water'], ['月', 'つき', 'moon'], ['金', 'かね', 'money'], ['土', 'つち', 'soil'], ['口', 'くち', 'mouth'],
  ['目', 'め', 'eye'], ['耳', 'みみ', 'ear'], ['手', 'て', 'hand'], ['足', 'あし', 'foot'], ['雨', 'あめ', 'rain'],
  ['花', 'はな', 'flower'], ['空', 'そら', 'sky'], ['石', 'いし', 'stone'], ['竹', 'たけ', 'bamboo'], ['糸', 'いと', 'thread'],
];
const MORE_WORDS: WordEntry[] = MORE_KANJI.map(([char, kana, en], i) => ({
  id: String(3001 + i), written: char, kana, meanings: [en], pos: ['n'], freqRank: 10, kanji: [char],
}));
const MORE_UNITS: CurriculumUnit[] = MORE_KANJI.map(([char], i) => ({
  index: CURRICULUM.units.length + i, char, anchor: `word:${3001 + i}`, staged: [], inferable: false,
  chapter: Math.floor((CURRICULUM.units.length + i) / 15) + 1,
}));
const MORE_KANJI_ENTRIES: Record<string, KanjiEntry> = Object.fromEntries(MORE_UNITS.map((u) => [u.char, {
  char: u.char, meanings: [MORE_KANJI[u.index - CURRICULUM.units.length][2]], on: [], kun: ['き'], strokeCount: 3,
  components: [], parts: [], rank: u.index + 1,
}]));
const MORE_CORE: CoreWord[] = ['ねこ', 'いぬ', 'うみ', 'くるま', 'でんしゃ', 'えき', 'みせ', 'へや', 'まど', 'いす',
  'かばん', 'くつ', 'ぼうし', 'めがね', 'さかな', 'にく', 'やさい', 'くだもの', 'おちゃ', 'みず', 'ごはん', 'パン',
  'たまご', 'さとう', 'しお', 'うた', 'え', 'ほん', 'かみ', 'ペン'].map((kana, i) => ({
  id: `cw-${String(CORE.length + 1 + i).padStart(4, '0')}`, order: CORE.length + 1 + i, kana, en: `thing ${i + 1}`,
  pos: 'noun', register: 'both', topic: 'test', use: true, kanji: [], unit: 2,
}));

function extendCourse(): void {
  fixtures.words = [...WORDS, ...MORE_WORDS];
  fixtures.curriculum = { ...CURRICULUM, units: [...CURRICULUM.units, ...MORE_UNITS] };
  fixtures.kanji = { ...KANJI, ...MORE_KANJI_ENTRIES };
  fixtures.core = [...CORE, ...MORE_CORE];
  fixtures.sentences = SENTENCES;
}

/** Study sentences of single core words, so the read block has i+1 sentences once those words are a few days old. */
const SENTENCES: SentenceEntry[] = [...CORE, ...MORE_CORE].filter((c) => !c.written).map((c) => ({
  id: `s-${c.id}`,
  jp: `${c.kana}。`,
  en: `${c.en}.`,
  grammar: [],
  tokens: [{ s: c.kana, k: 'c', ref: `core:${c.id}` }, { s: '。', k: 'p' }],
  refs: [`core:${c.id}`],
  unit: 1,
}));

const dayOf = (courseDay: number, hour = 9) => at(2026, 3, 1 + courseDay, hour);

/** Studies course days 1..`days` the way the engine test does: every warm-up card right, everything taught and checked. */
async function studyThrough(days: number): Promise<void> {
  for (let d = 1; d <= days; d++) {
    const now = dayOf(d);
    vi.setSystemTime(now);
    const plan = await planToday(now);
    await startSitting(plan, now);
    let t = now.getTime();
    const tick = () => new Date((t += 20_000));
    for (const id of plan.warmup) await gradeCard(id, Rating.Good, { durationMs: 8000, mode: 'typed', now: tick() });
    for (const batch of plan.teach) for (const item of batch.items) await introducePlanItem(item, tick());
    const fresh = await db.cards.where('state').equals(State.New).toArray();
    for (const card of fresh) await gradeCard(card.id, Rating.Good, { durationMs: 6000, mode: 'typed', context: 'first-check', now: tick() });
    await completeDay(tick());
  }
}

// ---------------------------------------------------------------------------
// The home server's AI: one particle issue on the first look, then a correction the card guard can verify
// ---------------------------------------------------------------------------

const DRAFT = 'ありがとう';
const EDITED = 'ありがとうね';

function aiReply(req: AiCheckRequest): AiCheckResponse {
  const base = { tips: [], grammarUsed: [] as string[] };
  if (req.mode === 'prompt') {
    return {
      ...base, ok: false, corrected: '', correctedRuby: '', diff: [], rule: '', words: [],
      issues: [{ quote: DRAFT, start: 0, end: DRAFT.length, type: 'particle', uncertain: false, hint: 'Add a word to soften it' }],
    };
  }
  const corrected = `${EDITED}。`;
  return {
    ...base, ok: false, issues: [], corrected, correctedRuby: corrected, rule: 'ね softens a thank-you between partners.',
    diff: [{ op: 'same', text: EDITED }, { op: 'ins', text: '。' }],
    words: [{ surface: DRAFT, lemma: DRAFT, reading: DRAFT }],
  };
}

// ---------------------------------------------------------------------------
// The autopilot
// ---------------------------------------------------------------------------

/** Kana answers by written form and by English, from the (extended) fixture course. */
const KANA_BY_WRITTEN = new Map<string, string>([
  ...[...WORDS, ...MORE_WORDS].map((w) => [w.written, w.kana] as const),
  ...[...CORE, ...MORE_CORE].map((c) => [c.written ?? c.kana, c.kana] as const),
]);
const KANA_BY_ENGLISH = new Map<string, string>([
  ...[...WORDS, ...MORE_WORDS].map((w) => [w.meanings.join('; '), w.kana] as const),
  ...[...CORE, ...MORE_CORE].map((c) => [c.en, c.kana] as const),
]);
const BUILD_TILES = GRAMMAR[0].buildItems[0].tiles;

interface Pilot {
  sitting: 'At my desk' | 'Anywhere (no pen)';
  /** The next answer in the warm-up is given wrong (once). */
  missInWarmup: boolean;
  /** What happened, for the failure message. */
  trail: string[];
  /** "Write on paper" was ever offered. */
  paperOffered: boolean;
  /** A step of the read block took this long, so its time is booked. */
  readPauseMs: number;
  paused: boolean;
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent?.trim() ?? '';
function buttonNamed(name: string | RegExp): HTMLButtonElement | null {
  const all = screen.queryAllByRole('button', { name }) as HTMLButtonElement[];
  return all.find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true') ?? null;
}
const stepLabel = () => text('.st-count');
const ask = () => text('h2.st-ask');

/** The kana a typed card or prompt wants, from what it shows. */
function typedAnswer(): string | null {
  const heading = ask();
  if (heading === 'Read this word') return text('.st-prompt .st-big');
  if (heading.startsWith('How do you read')) return KANA_BY_WRITTEN.get(text('u.st-target') || text('.st-prompt .st-big')) ?? null;
  if (heading === 'Say it in Japanese' || heading === 'Say it, or type it') return KANA_BY_ENGLISH.get(text('.st-english')) ?? null;
  return null;
}

function click(el: Element, what: string, pilot: Pilot): string {
  fireEvent.click(el);
  pilot.trail.push(`${stepLabel()} · ${what}`);
  return what;
}

/** One action, or null when the screen has nothing to do yet. Returns 'summary' at the end. */
async function step(pilot: Pilot): Promise<string | null> {
  if (screen.queryByRole('heading', { name: 'Done for now' })) return 'summary';
  if (buttonNamed('Write on paper')) pilot.paperOffered = true;
  const warmup = stepLabel().startsWith('Warm-up');
  const miss = warmup && pilot.missInWarmup;
  const took = (what: string) => {
    if (miss) pilot.missInWarmup = false;
    return what;
  };

  const sitting = buttonNamed(new RegExp(`^${pilot.sitting.replace(/[()]/g, '\\$&')}`));
  if (sitting) return click(sitting, `sitting ${pilot.sitting}`, pilot);

  const fast = q('.st-fb-fast');
  if (fast) return click(fast, 'feedback (fast)', pilot);

  // Handwriting (stand-in pad): from memory on cards and in the memory pass, or the lesson's trace and copy.
  const recall = buttonNamed(miss ? 'Leave a stroke out' : 'Write it right');
  if (recall) return took(click(recall, miss ? 'write it wrong' : 'write it', pilot));
  const lessonPad = buttonNamed('Finish writing');
  if (lessonPad) return click(lessonPad, 'trace/copy', pilot);

  // Tiles: the fixture's build item, in order. A tile may carry furigana, so its <rt> text is left out.
  const tray = q('.st-tile-tray');
  if (tray) {
    for (const tile of BUILD_TILES) {
      const button = [...tray.querySelectorAll<HTMLButtonElement>('button.st-tile')].find((b) => {
        const c = b.cloneNode(true) as HTMLElement;
        c.querySelectorAll('rt').forEach((rt) => rt.remove());
        return c.textContent === tile && !b.disabled;
      });
      if (button) return click(button, `tile ${tile}`, pilot);
    }
  }

  // Today's sentence: a draft, one edit after the first look, then send the correction.
  const sentence = screen.queryByRole('textbox', { name: 'Your sentence' }) as HTMLInputElement | null;
  if (sentence) {
    const first = screen.queryAllByRole('button', { name: 'Check it' })[0];
    if (first && !sentence.value) {
      fireEvent.change(sentence, { target: { value: 'arigatou' } });
      return click(first, 'draft the sentence', pilot);
    }
    const again = buttonNamed('Check again');
    if (again && sentence.value !== EDITED) {
      fireEvent.change(sentence, { target: { value: EDITED } });
      return click(again, 'edit once', pilot);
    }
  }
  const send = buttonNamed('Send the corrected one') ?? buttonNamed(/^Send to /);
  if (send) return click(send, 'send', pilot);

  // A typed answer (cards, the memory pass).
  const field = (screen.queryAllByRole('textbox') as HTMLInputElement[]).find((f) => !f.readOnly && f.getAttribute('aria-label') !== 'Your sentence');
  // Check stays disabled until something is typed.
  const check = screen.queryAllByRole('button', { name: 'Check' })[0] as HTMLButtonElement | undefined;
  if (field && check && !field.value) {
    if (miss) {
      const dunno = buttonNamed("I don't know");
      if (dunno) return took(click(dunno, "don't know", pilot));
    }
    const answer = typedAnswer();
    if (answer === null) throw new Error(`No answer for "${ask()}" / "${text('.st-prompt')}"`);
    fireEvent.change(field, { target: { value: answer } });
    return took(click(check, `type ${answer}`, pilot));
  }
  if (check && !check.disabled && q('.st-tile-tray')) return click(check, 'check the tiles', pilot);

  // Reveal, then grade yourself.
  const reveal = buttonNamed('Show the answer') ?? buttonNamed('Show the meaning') ?? buttonNamed('Show the word');
  if (reveal) return click(reveal, 'reveal', pilot);
  const grade = miss ? (buttonNamed('Missed') ?? buttonNamed('No')) : (buttonNamed('Got it') ?? buttonNamed('Yes'));
  if (grade) return took(click(grade, `self-grade ${grade.textContent}`, pilot));

  // Read & listen: read aloud, listen, guess the word, then on to the next.
  if (ask() === 'Read it aloud first') {
    if (!pilot.paused) {
      // Reading takes a moment; the time is booked against the strand reserve when the step ends.
      pilot.paused = true;
      await new Promise((r) => setTimeout(r, pilot.readPauseMs));
    }
    const listen = buttonNamed('Listen');
    if (listen) return click(listen, 'listen', pilot);
  }
  const meaning = buttonNamed('What does it mean?');
  if (meaning) return click(meaning, 'gloss', pilot);
  const choice = q<HTMLButtonElement>('.st-choices .choice:not([aria-disabled])');
  if (choice) return click(choice, 'pick a gloss', pilot);

  // Lessons.
  // 'Hear it': the read step's kana words (recent core words before the sentences, after the sprint).
  for (const name of ['Show me', 'See how it works', 'Try it', 'Trace it', 'Copy it', 'Hear it', 'Next sentence', 'Next word', 'Next', 'Continue', 'Done']) {
    const button = buttonNamed(name);
    if (button) return click(button, name, pilot);
  }
  return null;
}

/** Runs the session until the summary, one action at a time. */
async function runSession(pilot: Pilot): Promise<void> {
  let idle = 0;
  for (let n = 0; n < 600; n++) {
    let did: string | null = null;
    await act(async () => {
      did = await step(pilot);
    });
    if (did === 'summary') return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, did ? 5 : 25));
    });
    idle = did ? 0 : idle + 1;
    if (idle > 200) break;
  }
  throw new Error(`The session did not reach its summary.\n${pilot.trail.slice(-25).join('\n')}\n---\n${document.body.textContent?.slice(0, 1500)}`);
}

function renderSession() {
  return render(
    <MemoryRouter initialEntries={['/session']}>
      <Routes>
        <Route path="/session" element={<Session />} />
        <Route path="/" element={<p>Today</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const pilotFor = (sitting: Pilot['sitting'], missInWarmup = false): Pilot =>
  ({ sitting, missInWarmup, trail: [], paperOffered: false, readPauseMs: 1100, paused: false });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  await resetDb();
  extendCourse();
  await db.settings.put({ ...DEFAULT_SETTINGS, onboarded: true, audio: false });
  vi.mocked(aiCheck).mockReset().mockImplementation(async (req) => aiReply(req));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('one full desk sitting on the real engine (§5.2 test 2)', () => {
  it('warm-up with a miss and its graded re-ask → teach → memory → read → check → output → summary', { timeout: 120_000 }, async () => {
    await studyThrough(19);
    const now = dayOf(20);
    vi.setSystemTime(now);
    const today = dayKey(now);
    const plan = await planToday(now, { sitting: 'desk' });
    expect(plan.courseDay).toBe(20);
    expect(plan.warmup.length).toBeGreaterThan(0);
    expect(plan.teach.length).toBeGreaterThan(0);
    expect(plan.read).not.toBeNull();
    expect(plan.output).not.toBeNull();

    renderSession();
    const pilot = pilotFor('At my desk', true);
    await runSession(pilot);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Each step ran, in the session's order.
    const visited = [...new Set(pilot.trail.map((t) => t.split(' · ')[0].replace(/ \d.*$/, '')).filter(Boolean))];
    expect(visited).toEqual(['Warm-up', 'New', 'Memory', 'Read', 'Check', 'Sentence']);

    const day = (await db.days.get(today))!;
    expect(day.goalMet).toBe(true);
    expect(day.minimumDone).toBe(true);
    expect([...day.steps].sort()).toEqual(['output', 'read']);

    // reviewMs holds the warm-up answers only (re-asks included, first checks not); strandMs the read and output time.
    const logs = await db.reviewLogs.where('reviewedAt').aboveOrEqual(new Date(now.getTime() - 5 * 3600_000)).toArray();
    const counted = (context: string[]) => logs.filter((l) => context.includes(l.context))
      .reduce((sum, l) => sum + Math.min(Math.max(0, Math.round(l.durationMs)), 120_000), 0);
    expect(day.reviewMs).toBe(counted(['review', 're-ask']));
    expect(logs.some((l) => l.context === 'first-check')).toBe(true);
    expect(day.strandMs).toBeGreaterThanOrEqual(1000);

    // The miss came back graded, after at least five other cards when there were that many.
    const reask = logs.find((l) => l.context === 're-ask');
    expect(reask).toBeDefined();
    const first = logs.find((l) => l.cardId === reask!.cardId && l.context === 'review')!;
    expect(first.grade).toBe(Rating.Again);
    // The clock stands still in this test: log ids give the order.
    const between = logs.filter((l) => l.id! > first.id! && l.id! < reask!.id! && l.context === 'review').length;
    expect(between).toBe(Math.min(5, plan.warmup.length - 1));

    // Today's sentence went to the partner, and its verified correction is a cloze card (first checked next time).
    const outbox = await db.outbox.toArray();
    expect(outbox.map((o) => [o.tag, o.text])).toEqual([['daily', `${EDITED}。`]]);
    const output = (await db.outputs.toArray())[0];
    expect(output).toMatchObject({ check: 'done', draft: DRAFT, text: `${EDITED}。` });
    expect(output.cardId).toBeDefined();
    expect(await db.cards.get(output.cardId!)).toMatchObject({ type: 'cloze', state: State.New });

    // Every card taught today had its first check: the cloze card made after the check is the only New card.
    expect((await db.cards.where('state').equals(State.New).primaryKeys())).toEqual([output.cardId]);
    expect(vi.mocked(aiCheck).mock.calls.map(([r]) => r.mode)).toEqual(['prompt', 'reveal']);
    expect(pilot.paperOffered).toBe(true);
  });
});

describe('a split day on the real engine (§5.2 test 3b)', () => {
  it('an anywhere sitting in the morning, then a desk sitting in the evening that meets the goal', { timeout: 120_000 }, async () => {
    await studyThrough(29);
    const morning = dayOf(30, 8);
    vi.setSystemTime(morning);
    const today = dayKey(morning);

    // Morning: the whole warm-up, handwriting on the pad but never on paper; no lessons, and the day isn't complete.
    const view = renderSession();
    const am = pilotFor('Anywhere (no pen)');
    await runSession(am);
    expect(am.paperOffered).toBe(false);
    expect(am.trail.some((t) => /New|Read|Check|Sentence/.test(t.split(' · ')[0]))).toBe(false);
    const afterMorning = (await db.days.get(today))!;
    expect(afterMorning.goalMet).toBe(false);
    const morningLogs = await db.reviewLogs.where('reviewedAt').aboveOrEqual(morning).toArray();
    view.unmount();

    // Evening: only what became due since, then teach, read, check and output.
    const evening = dayOf(30, 19);
    vi.setSystemTime(evening);
    const plan = await planToday(evening, { sitting: 'desk' });
    expect(plan.partOfDayDone).toBe(true);
    expect(plan.warmup.filter((id) => morningLogs.some((l) => l.cardId === id))).toEqual([]);
    expect(plan.teach.length).toBeGreaterThan(0);
    renderSession();
    const pm = pilotFor('At my desk');
    await runSession(pm);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const day = (await db.days.get(today))!;
    expect(day.goalMet).toBe(true);
    expect([...day.steps].sort()).toEqual(['output', 'read']);
    const reviews = (await db.reviewLogs.where('reviewedAt').aboveOrEqual(morning).toArray()).filter((l) => l.context === 'review');
    expect(new Set(reviews.map((l) => l.cardId)).size).toBe(reviews.length);
  });
});

describe('a sentence sent offline, checked later (§5.2 test 4)', () => {
  it('goes out with its check pending, is checked once the server is back, and the next session shows it', { timeout: 120_000 }, async () => {
    await studyThrough(19);
    vi.setSystemTime(dayOf(20, 20));
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const view = renderSession();
    await runSession(pilotFor('At my desk'));
    online.mockRestore();
    view.unmount();

    // Sent as written; nothing asked the AI, and nothing became a card.
    expect((await db.outbox.toArray()).map((o) => [o.tag, o.text])).toEqual([['daily', DRAFT]]);
    const [sent] = await db.outputs.toArray();
    expect(sent).toMatchObject({ check: 'pending', text: DRAFT });
    expect(sent.resultSeen).toBeUndefined();
    expect(aiCheck).not.toHaveBeenCalled();
    expect((await db.days.get(dayKey(dayOf(20))))!.steps).toContain('output');

    // Back online and paired: the sync layer runs the check, and the guard turns the correction into a cloze card.
    await db.settings.update('me', { deviceToken: 'token-1', memberId: 'member-1', serverUrl: '' });
    expect(await flushPendingOutputChecks()).toBe(1);
    expect(vi.mocked(aiCheck).mock.calls.map(([r]) => [r.mode, r.text])).toEqual([['reveal', DRAFT]]);
    const checked = (await db.outputs.get(sent.id))!;
    expect(checked.check).toBe('done');
    expect(await db.cards.get(checked.cardId!)).toMatchObject({ type: 'cloze' });

    // The next day's session opens with it, once.
    vi.setSystemTime(dayOf(21));
    const next = renderSession();
    fireEvent.click(await screen.findByRole('button', { name: /^At my desk/ }));
    expect(await screen.findByRole('heading', { name: 'Your sentence was checked' })).toBeTruthy();
    expect(screen.getByText(/From yesterday/)).toBeTruthy();
    expect(screen.getByText('ね。', { selector: 'ins' })).toBeTruthy();
    expect(screen.getByText('The corrected sentence is now a card.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/^Warm-up/)).toBeTruthy();
    await vi.waitFor(async () => expect((await db.outputs.get(sent.id))!.resultSeen).toBe(true));
    next.unmount();
  });
});
