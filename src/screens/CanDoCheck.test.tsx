import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioMock, resetStudyDb, UNITS } from '../components/study/test-utils.tsx';
import { db } from '../lib/db.ts';
import type { CanDo } from '../lib/types.ts';
import { aiCanDo, ApiError, health, isPaired } from '../sync/client.ts';
import CanDoCheck, { AI_OFF, CanDoCheckView, LISTEN_PLAYS, NEEDS_SERVER } from './CanDoCheck.tsx';

vi.mock('../lib/data.ts', async () => (await import('../components/study/test-utils.tsx')).dataMock);
vi.mock('../speech/audio.ts', async () => (await import('../components/study/test-utils.tsx')).audioMock);
vi.mock('../speech/recognition.ts', () => ({ recognitionAvailable: () => false, listen: vi.fn() }));
vi.mock('../sync/client.ts', async (original) => ({
  ...(await original<typeof import('../sync/client.ts')>()),
  aiCanDo: vi.fn(),
  health: vi.fn(),
  isPaired: vi.fn(async () => false),
}));

const UNIT = UNITS[0];
const [READ, LISTEN, SPEAK, WRITE] = UNIT.canDos;

function screenFor(id: string) {
  render(
    <MemoryRouter initialEntries={[`/cando/${id}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes><Route path="/cando/:id" element={<CanDoCheck />} /></Routes>
    </MemoryRouter>,
  );
}

/** Answers the read check's three questions, getting `right` of them right. */
function answer(right: number) {
  const picks = [['Coffee', 'Tea'], ['Yes', 'No'], ['300 yen', '100 yen']];
  picks.forEach(([good, bad], i) => fireEvent.click(screen.getByRole('radio', { name: i < right ? good : bad })));
  fireEvent.click(screen.getByRole('button', { name: 'Check my answers' }));
}

beforeEach(async () => {
  await resetStudyDb();
  await db.items.put({ id: 'grammar:wa-desu', kind: 'grammar', key: 'wa-desu', introducedAt: new Date() });
  vi.mocked(aiCanDo).mockReset();
  vi.mocked(isPaired).mockReset().mockResolvedValue(false);
  vi.mocked(health).mockReset().mockResolvedValue({ ok: true, version: 'test', aiEnabled: true, ttsEnabled: false });
  audioMock.play.mockReset().mockResolvedValue({ via: 'clip', ms: 1000, interrupted: false });
});

afterEach(() => {
  cleanup();
});

describe('CanDoCheck', () => {
  it('passes a read check with 2 of 3 and records it', async () => {
    screenFor(READ.id);
    expect(await screen.findByText('Read a simple menu')).toBeTruthy();
    answer(2);
    expect(await screen.findByText(/2 of 3 — you can do this/)).toBeTruthy();
    await waitFor(async () => expect(await db.canDos.get(READ.id)).toMatchObject({ attempts: 1, via: 'auto' }));
    expect((await db.canDos.get(READ.id))?.passedAt).toBeInstanceOf(Date);
  });

  it('does not pass with 1 of 3, but counts the attempt', async () => {
    screenFor(READ.id);
    await screen.findByText('Read a simple menu');
    answer(1);
    expect(await screen.findByText(/1 of 3 — not yet/)).toBeTruthy();
    await waitFor(async () => expect(await db.canDos.get(READ.id)).toMatchObject({ attempts: 1 }));
    expect((await db.canDos.get(READ.id))?.passedAt).toBeUndefined();
  });

  it('shows "Check coming soon" for a check still being written', async () => {
    screenFor(WRITE.id);
    expect(await screen.findByText('Check coming soon')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Check/ })).toBeNull();
  });

  it('a speak check without the AI says it needs the home server and records nothing', async () => {
    vi.mocked(aiCanDo).mockRejectedValue(new ApiError(0, 'unpaired'));
    screenFor(SPEAK.id);
    fireEvent.change(await screen.findByLabelText('What you said'), { target: { value: 'わたしはカーターです' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText(NEEDS_SERVER)).toBeTruthy();
    expect(await db.canDos.count()).toBe(0);
  });

  it('a speak check on a server whose AI is off is not sent, and says the checker is off (V045)', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(health).mockResolvedValue({ ok: true, version: 'test', aiEnabled: false, ttsEnabled: false });
    screenFor(SPEAK.id);
    fireEvent.change(await screen.findByLabelText('What you said'), { target: { value: 'わたしはカーターです' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText(AI_OFF)).toBeTruthy();
    expect(AI_OFF).toMatch(/^Needs the home server/);
    expect(screen.queryByText(NEEDS_SERVER)).toBeNull();
    expect(aiCanDo).not.toHaveBeenCalled();
    expect(await db.canDos.count()).toBe(0);
  });

  it('a server that refuses with ai_disabled anyway gets the same answer', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(aiCanDo).mockRejectedValue(new ApiError(503, 'ai_disabled'));
    screenFor(SPEAK.id);
    fireEvent.change(await screen.findByLabelText('What you said'), { target: { value: 'わたしはカーターです' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText(AI_OFF)).toBeTruthy();
    expect(await db.canDos.count()).toBe(0);
  });

  it('speak and write checks show their material, and a speak check’s lines can be played (V037)', async () => {
    const speak: CanDo = { ...SPEAK, check: { ...SPEAK.check, material: '「こんにちは。{隣|となり}の{田中|たなか}です。」' } };
    const { unmount } = render(<CanDoCheckView canDo={speak} unit={UNIT} />);
    expect(document.querySelector('.st-material')?.textContent).toContain('こんにちは。');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(audioMock.play).toHaveBeenCalledWith({ ref: `cando:${SPEAK.id}` }, { fallbackText: speak.check.material });
    unmount();

    const write: CanDo = { ...SPEAK, id: 'u03-cd3', check: { kind: 'write', instructions: 'Your partner left this note on the fridge.', material: 'あしたは{何時|なんじ}に{出|で}ますか？', questions: [], rubric: ['Says a time'] } };
    render(<CanDoCheckView canDo={write} unit={UNIT} />);
    expect(document.querySelector('.st-material')?.textContent).toContain('ますか？');
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.getByLabelText('What you wrote')).toBeTruthy();
  });

  it('after the check, the questions stay with the right answers marked and a wrong pick shown (V046)', async () => {
    screenFor(READ.id);
    await screen.findByText('Read a simple menu');
    answer(2);
    expect(await screen.findByText(/2 of 3 — you can do this/)).toBeTruthy();
    expect(screen.getByText('How much?')).toBeTruthy();
    const wrong = screen.getByRole('radio', { name: /100 yen, your answer/ });
    expect(wrong.className).toContain('wrong');
    const right = screen.getByRole('radio', { name: /300 yen, correct answer/ });
    expect(right.className).toContain('correct');
    expect(screen.queryByRole('button', { name: 'Check my answers' })).toBeNull();
  });

  it('a listen check plays its material twice at most (V048)', async () => {
    screenFor(LISTEN.id);
    for (let n = 0; n < LISTEN_PLAYS; n++) {
      const button = await screen.findByRole('button', { name: n ? 'Play again' : 'Play' });
      fireEvent.click(button);
      await waitFor(() => expect(audioMock.play).toHaveBeenCalledTimes(n + 1));
    }
    const done = await screen.findByRole('button', { name: 'Played twice' });
    expect(done.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(done);
    expect(audioMock.play).toHaveBeenCalledTimes(LISTEN_PLAYS);
    expect(screen.getByText('That was the last play.')).toBeTruthy();
  });

  it('a play that could not sound does not count', async () => {
    audioMock.play.mockResolvedValueOnce({ via: 'none', ms: 0, interrupted: false });
    screenFor(LISTEN.id);
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await waitFor(() => expect(screen.queryByText('One more play left.')).toBeNull());
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }));
    expect(await screen.findByText('One more play left.')).toBeTruthy();
  });

  it('a speak check passed by the AI is recorded via the AI', async () => {
    vi.mocked(aiCanDo).mockResolvedValue({ met: [true, true], passed: true, feedback: 'Clear.' });
    screenFor(SPEAK.id);
    fireEvent.change(await screen.findByLabelText('What you said'), { target: { value: 'わたしはカーターです' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText('You can do this')).toBeTruthy();
    expect(aiCanDo).toHaveBeenCalledWith({ canDoId: SPEAK.id, kind: 'speak', rubric: SPEAK.check.rubric, text: 'わたしはカーターです' });
    await waitFor(async () => expect(await db.canDos.get(SPEAK.id)).toMatchObject({ via: 'ai' }));
  });

  it('a listen check plays the material before the questions', async () => {
    screenFor(LISTEN.id);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }));
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
  });

  it('showcase mode records nothing', async () => {
    render(<CanDoCheckView canDo={READ} unit={UNIT} showcase />);
    answer(3);
    expect(await screen.findByText(/3 of 3/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.canDos.count()).toBe(0);
  });

  it('stays closed until the unit’s grammar is learned', async () => {
    await db.items.delete('grammar:wa-desu');
    screenFor(READ.id);
    expect(await screen.findByText('Not open yet')).toBeTruthy();
  });
});
