import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCheckResponse } from '../../../shared/api.ts';
import { updateSettings } from '../../lib/db.ts';
import type { OutputSentenceRecord } from '../../lib/types.ts';
import { logEncounters } from '../../srs/encounters.ts';
import { completeOutputCheck, saveOutput } from '../../srs/output.ts';
import { aiCheck, aiReport, ApiError, health, isPaired } from '../../sync/client.ts';
import { queueChatMessage } from '../../sync/outbox.ts';
import { OutputStep } from './OutputStep.tsx';
import { resetStudyDb } from './test-utils.tsx';

vi.mock('../../lib/data.ts', async () => (await import('./test-utils.tsx')).dataMock);
vi.mock('../../sync/client.ts', async (original) => ({
  ...(await original<typeof import('../../sync/client.ts')>()),
  aiCheck: vi.fn(),
  aiReport: vi.fn(async () => {}),
  health: vi.fn(),
  isPaired: vi.fn(async () => false),
}));
vi.mock('../../sync/outbox.ts', () => ({ queueChatMessage: vi.fn(async () => 'client-1') }));
vi.mock('../../srs/encounters.ts', () => ({ logEncounters: vi.fn(async () => 1) }));
vi.mock('../../srs/output.ts', () => ({
  learnerAiContext: vi.fn(async () => ({ knownGrammar: ['wa-desu'] })),
  saveOutput: vi.fn(async (rec: Omit<OutputSentenceRecord, 'id' | 'createdAt'>) => ({ ...rec, id: 'out-1', createdAt: new Date() })),
  completeOutputCheck: vi.fn(async () => ({ cardId: 'sentence:custom-1|cloze' })),
}));

const TARGET = { ref: 'core:cw-0003', label: 'もう', en: 'already' };
const DRAFT = 'もうたべるました';
const EDITED = 'もうたべるでした';
const CORRECTED = 'もうたべました';

const promptResult: AiCheckResponse = {
  ok: false,
  issues: [{ quote: 'たべるました', start: 2, end: 8, type: 'conjugation', uncertain: false, hint: 'Check the verb form' }],
  corrected: '', correctedRuby: '', diff: [], rule: '', grammarUsed: [], words: [], tips: [],
};
const revealResult: AiCheckResponse = {
  ok: false,
  issues: [],
  corrected: CORRECTED,
  correctedRuby: CORRECTED,
  diff: [{ op: 'same', text: 'もうたべ' }, { op: 'del', text: 'るで' }, { op: 'ins', text: 'ま' }, { op: 'same', text: 'した' }],
  rule: 'Polite past: stem + ました.',
  grammarUsed: ['other'],
  words: [{ surface: 'もう', lemma: 'もう', reading: 'もう' }],
  tips: [],
};

function step() {
  const onDone = vi.fn();
  render(<OutputStep target={TARGET} partnerName="Taylor" onDone={onDone} />);
  return onDone;
}

const typeSentence = (text: string) => fireEvent.change(screen.getByLabelText('Your sentence'), { target: { value: text } });

beforeEach(async () => {
  await resetStudyDb();
  vi.mocked(aiCheck).mockReset();
  vi.mocked(aiReport).mockClear();
  vi.mocked(isPaired).mockReset().mockResolvedValue(false);
  vi.mocked(health).mockReset().mockResolvedValue({ ok: true, version: 'test', aiEnabled: true, ttsEnabled: false });
  vi.mocked(queueChatMessage).mockClear();
  vi.mocked(saveOutput).mockClear();
  vi.mocked(completeOutputCheck).mockClear();
  vi.mocked(logEncounters).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OutputStep', () => {
  it('prompt → one edit → reveal, and no corrected text before the reveal', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt' ? promptResult : revealResult));
    const onDone = step();
    expect(screen.getByRole('heading', { name: /Tell Taylor something using/ })).toBeTruthy();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));

    // Prompt mode: the span is marked with its type; the fix is nowhere.
    expect(await screen.findByText('Conjugation')).toBeTruthy();
    expect(screen.getByText('たべるました', { selector: 'mark' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(CORRECTED);
    expect(vi.mocked(aiCheck).mock.calls[0][0]).toMatchObject({ mode: 'prompt', text: DRAFT, target: 'もう', knownGrammar: ['wa-desu'] });

    typeSentence(EDITED);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Here is the correction')).toBeTruthy();
    expect(vi.mocked(aiCheck).mock.calls[1][0]).toMatchObject({ mode: 'reveal', text: EDITED, firstAttempt: DRAFT });
    expect(screen.getByText('るで', { selector: 'del' })).toBeTruthy();
    expect(screen.getByText('ま', { selector: 'ins' })).toBeTruthy();
    expect(document.body.textContent).toContain('Polite past: stem + ました.');

    fireEvent.click(screen.getByRole('button', { name: /Send the corrected one/ }));
    expect(await screen.findByText('Sent to Taylor')).toBeTruthy();
    expect(queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: CORRECTED, tag: 'daily' });
    // The learner saw this check, so the next session does not show it again.
    expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ draft: DRAFT, text: CORRECTED, check: 'done', chatClientId: 'client-1', resultSeen: true }));
    expect(completeOutputCheck).toHaveBeenCalledWith('out-1', revealResult);
    expect(logEncounters).toHaveBeenCalledWith(['core:cw-0003'], 'output');
    expect(screen.getByText('The corrected sentence is now a card.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('offline: the sentence is sent anyway and its check waits', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText(/runs when the home server is reachable/)).toBeTruthy();
    // Nothing is sent yet, so nothing says it was (V062).
    expect(screen.getByRole('status').textContent).toBe('No check for now: it runs when the home server is reachable.');
    expect(document.body.textContent).not.toMatch(/Sent/);
    expect(aiCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Send to Taylor/ }));
    expect(await screen.findByText('Sent to Taylor')).toBeTruthy();
    expect(queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: DRAFT, tag: 'daily' });
    expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ check: 'pending', text: DRAFT }));
    // Its result comes later and is shown by the next session.
    expect(vi.mocked(saveOutput).mock.calls[0][0]).not.toHaveProperty('resultSeen');
    expect(completeOutputCheck).not.toHaveBeenCalled();
    online.mockRestore();
  });

  it('without the AI the check is unavailable and the sentence still goes', async () => {
    vi.mocked(aiCheck).mockRejectedValue(new ApiError(503, 'ai_disabled'));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    fireEvent.click(await screen.findByRole('button', { name: /Send to Taylor/ }));
    await waitFor(() => expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ check: 'unavailable' })));
  });

  it('paired with a server whose AI is off: no check is sent, and the note says the checker is off (V045, V087)', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(health).mockResolvedValue({ ok: true, version: 'test', aiEnabled: false, ttsEnabled: false });
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText('The sentence checker is turned off on the home server. Your sentence goes to Taylor as it is.')).toBeTruthy();
    expect(screen.queryByText(/needs the home server/)).toBeNull();
    expect(aiCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Send to Taylor/ }));
    await waitFor(() => expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ check: 'unavailable', text: DRAFT })));
  });

  it('paired with a server that answers ai_disabled anyway: the note still says the checker is off', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(aiCheck).mockRejectedValue(new ApiError(503, 'ai_disabled'));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText(/The sentence checker is turned off on the home server/)).toBeTruthy();
  });

  it('paired but the server is unreachable: the check waits, without asking the AI', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(health).mockRejectedValue(new ApiError(0, 'network'));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText('No check for now: it runs when the home server is reachable.')).toBeTruthy();
    expect(aiCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Send to Taylor/ }));
    await waitFor(() => expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ check: 'pending' })));
  });

  it('paired with the AI on: the check runs as usual', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt' ? promptResult : revealResult));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText('Conjugation')).toBeTruthy();
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('the one-line rule flows as one line of mixed Japanese and English (V064)', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt' ? promptResult : { ...revealResult, rule: 'い-adjectives drop い before くない: たかい → たかくない.' }));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    typeSentence(EDITED);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    const note = (await screen.findByText(/adjectives drop/)).closest('.st-fb-note')!;
    expect(note.textContent).toBe('い-adjectives drop い before くない: たかい → たかくない.');
    // jsdom has no layout: the note must not be a flex row, which split each Japanese run into its own item.
    const css = readFileSync(join(process.cwd(), 'src/components/study/study.css'), 'utf8');
    const rule = css.match(/\.st-fb-note \{([^}]*)\}/)![1];
    expect(rule).not.toMatch(/display:\s*(inline-)?flex/);
  });

  it('"This tip seems wrong" reports the tip and marks the sentence', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt' ? promptResult : revealResult));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    typeSentence(EDITED);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'This tip seems wrong' }));
    expect(aiReport).toHaveBeenCalledWith(expect.objectContaining({ kind: 'check', text: DRAFT }));
    expect(screen.getByRole('button', { name: /noted/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send mine' }));
    await waitFor(() => expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ reported: true, text: EDITED })));
  });

  it('"Just show me" goes straight to the correction with one call', async () => {
    await updateSettings({ justShowMe: true });
    vi.mocked(aiCheck).mockResolvedValue(revealResult);
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText('A suggestion')).toBeTruthy();
    expect(aiCheck).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiCheck).mock.calls[0][0]).toMatchObject({ mode: 'reveal', text: DRAFT });
  });

  it('a word-choice issue is only flagged, and revealed when the learner taps "Show me"', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt'
      ? { ...promptResult, issues: [{ ...promptResult.issues[0], type: 'word-choice', uncertain: true }] }
      : revealResult));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    expect(await screen.findByText('Word choice · maybe')).toBeTruthy();
    expect(document.body.textContent).not.toContain(CORRECTED);
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(await screen.findByText('A suggestion')).toBeTruthy();
  });

  const wordChoice = { ...promptResult.issues[0], type: 'word-choice' as const, uncertain: false };

  it('after the edit, a word-choice issue that remains is still only flagged until "Show me"', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt'
      ? { ...promptResult, issues: [wordChoice] }
      : { ...revealResult, issues: [{ ...wordChoice, quote: 'たべるでした', start: 2, end: 8 }] }));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    typeSentence(EDITED);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));

    // The reveal ran (the card guard needs it), but its correction waits to be asked for.
    expect(await screen.findByText('A word might still fit better')).toBeTruthy();
    expect(vi.mocked(aiCheck).mock.calls[1][0]).toMatchObject({ mode: 'reveal', text: EDITED, firstAttempt: DRAFT });
    expect(screen.getByText('たべるでした', { selector: 'mark' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(CORRECTED);
    expect(document.body.textContent).not.toContain('Polite past');
    expect(screen.queryByRole('button', { name: /Send the corrected one/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(screen.getByText('るで', { selector: 'del' })).toBeTruthy();
    expect(document.body.textContent).toContain('Polite past: stem + ました.');
    expect(screen.getByRole('button', { name: /Send the corrected one/ })).toBeTruthy();
  });

  it('a held word-choice suggestion can be sent without looking', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt'
      ? { ...promptResult, issues: [wordChoice] }
      : { ...revealResult, issues: [wordChoice] }));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    typeSentence(EDITED);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    fireEvent.click(await screen.findByRole('button', { name: /Send mine/ }));
    expect(await screen.findByText('Sent to Taylor')).toBeTruthy();
    expect(queueChatMessage).toHaveBeenCalledWith({ kind: 'text', text: EDITED, tag: 'daily' });
    expect(saveOutput).toHaveBeenCalledWith(expect.objectContaining({ text: EDITED, check: 'done' }));
  });

  it('after the edit of a word-choice flag, a grammar issue is revealed at once', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt'
      ? { ...promptResult, issues: [wordChoice] }
      : { ...revealResult, issues: [promptResult.issues[0]] }));
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    typeSentence(EDITED);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Here is the correction')).toBeTruthy();
    expect(screen.getByText('ま', { selector: 'ins' })).toBeTruthy();
  });

  it('tells how to type katakana, under the field (V061)', () => {
    step();
    const hint = document.getElementById(screen.getByLabelText('Your sentence').getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/Type CAPITALS for katakana: KE-KI → ケーキ/);
  });

  it('keeps keyboard focus when Check it and Send give way (V086)', async () => {
    vi.mocked(isPaired).mockResolvedValue(true);
    vi.mocked(health).mockResolvedValue({ ok: true, version: 'test', aiEnabled: false, ttsEnabled: false });
    step();
    typeSentence(DRAFT);
    const checkIt = screen.getByRole('button', { name: 'Check it' });
    checkIt.focus();
    fireEvent.click(checkIt);
    const send = await screen.findByRole('button', { name: /Send to Taylor/ });
    expect(document.activeElement).toBe(send);
    fireEvent.click(send);
    const next = await screen.findByRole('button', { name: 'Continue' });
    expect(document.activeElement).toBe(next);
  });

  it('moves focus to the field when the first look marks something to fix', async () => {
    vi.mocked(aiCheck).mockImplementation(async (req) => (req.mode === 'prompt' ? promptResult : revealResult));
    step();
    typeSentence(DRAFT);
    const checkIt = screen.getByRole('button', { name: 'Check it' });
    checkIt.focus();
    fireEvent.click(checkIt);
    expect(await screen.findByText('Conjugation')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Your sentence'));
  });

  it('a send retried after the save failed queues the chat message once', async () => {
    vi.mocked(aiCheck).mockRejectedValue(new ApiError(503, 'ai_disabled'));
    vi.mocked(saveOutput).mockRejectedValueOnce(new Error('QuotaExceededError'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    step();
    typeSentence(DRAFT);
    fireEvent.click(screen.getByRole('button', { name: 'Check it' }));
    fireEvent.click(await screen.findByRole('button', { name: /Send to Taylor/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Sent to Taylor')).toBeTruthy();
    expect(queueChatMessage).toHaveBeenCalledTimes(1);
    expect(saveOutput).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveOutput).mock.calls[1][0]).toMatchObject({ chatClientId: 'client-1', text: DRAFT });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
