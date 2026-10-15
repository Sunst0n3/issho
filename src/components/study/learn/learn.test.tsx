import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import type { CardRecord, ItemRecord } from '../../../lib/types.ts';
import type { NewItemPlan } from '../../../srs/course.ts';
import type { IntroduceResult } from '../../../srs/items.ts';
import { listen, recognitionAvailable } from '../../../speech/recognition.ts';
import { audioMock, KANA_RULES, resetStudyDb } from '../test-utils.tsx';
import { CoreWordLesson, LISTEN_FIRST_MS } from './CoreWordLesson.tsx';
import { learnedItem, loadLesson, wordRuby, youCanNow, type LessonData } from './data.ts';
import { KanaRuleLesson } from './KanaRuleLesson.tsx';
import { KanjiLesson, MemoryHook, MNEMONIC_MAX } from './KanjiLesson.tsx';
import { MemoryPass } from './MemoryPass.tsx';
import { StagedWordLesson } from './StagedWordLesson.tsx';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);
vi.mock('../../../writing/WritingPad.tsx', async () => (await import('../test-utils.tsx')).writingPadMock);
vi.mock('../../../speech/audio.ts', async () => (await import('../test-utils.tsx')).audioMock);
vi.mock('../../../speech/recognition.ts', () => ({ recognitionAvailable: vi.fn(() => false), listen: vi.fn() }));

const plan = (kind: NewItemPlan['kind'], key: string, extra: Partial<NewItemPlan> = {}): NewItemPlan =>
  ({ itemId: `${kind}:${key}`, kind, key, priceSec: 60, stream: kind === 'kanji' ? 'kanji' : 'core', ...extra } as NewItemPlan);

async function introduced(kind: ItemRecord['kind'], key: string) {
  await db.items.put({ id: `${kind}:${key}`, kind, key, introducedAt: new Date() });
}

function result(itemId: string, kind: ItemRecord['kind'], types: CardRecord['type'][], reps = 0): IntroduceResult {
  const item: ItemRecord = { id: itemId, kind, key: itemId.slice(kind.length + 1), introducedAt: new Date() };
  const cards = types.map((type) => ({ id: cardId(itemId, type), itemId, kind, type, reps, suspended: false }) as unknown as CardRecord);
  return { item, cards, created: true };
}

beforeEach(async () => {
  await resetStudyDb();
  audioMock.play.mockClear();
  vi.mocked(recognitionAvailable).mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('loadLesson', () => {
  it('gives a kanji its anchor word, hook and parts, each part known or new', async () => {
    const lesson = await loadLesson(plan('kanji', '休', { anchor: 'word:w-yasumi' }));
    expect(lesson?.kind).toBe('kanji');
    const k = lesson as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.anchor?.written).toBe('休み');
    expect(k.unit?.inferable).toBe(true);
    expect(k.parts).toEqual([
      { char: '人', name: 'person', kind: 'kanji', known: false },
      { char: '木', name: 'tree', kind: 'kanji', known: false },
      { char: '亻', name: 'person (side)', kind: 'part', known: false },
    ]);
    expect(k.newPart).toBe(true);
  });

  it('needs no trace once every component kanji was introduced and every named part was seen', async () => {
    await introduced('kanji', '人');
    await introduced('kanji', '木');
    await introduced('kanji', '池');
    // 亻 has not been seen in any earlier lesson: still new.
    let k = (await loadLesson(plan('kanji', '休'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.parts.map((p) => p.known)).toEqual([true, true, false]);
    expect(k.newPart).toBe(true);
    // The anchor and the hook come from the curriculum and the mnemonics.
    k = (await loadLesson(plan('kanji', '水'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.anchor?.ref).toBe('word:w-mizu');
    expect(k.mnemonic?.sound).toBe('Me-zoo drinks water.');
    expect(k.anchorAccent?.type).toBe('heiban');
    expect(k.newPart).toBe(false);
  });

  it('shows a core word in kana until every kanji of its spelling is taught', async () => {
    let core = (await loadLesson(plan('core', 'cw-0002'))) as Extract<LessonData, { kind: 'core' }>;
    expect(core.display).toBe('たべる');
    await introduced('kanji', '食');
    core = (await loadLesson(plan('core', 'cw-0002'))) as Extract<LessonData, { kind: 'core' }>;
    expect(core.display).toBe('{食べる|たべる}');
    expect(wordRuby({ written: 'ありがとう', kana: 'ありがとう' })).toBe('ありがとう');
  });

  it('gives a kana its picture hook and example word, and a rule its pairs', async () => {
    expect(await loadLesson(plan('kana', 'あ'))).toMatchObject({ kind: 'kana', example: { kana: 'あめ', hook: 'An apple with a stem and a leaf.' } });
    expect(await loadLesson(plan('kanaRule', 'hira-dakuten'))).toMatchObject({ kind: 'kanaRule', rule: { id: 'hira-dakuten' } });
    expect(await loadLesson(plan('kanji', '龍'))).toBeNull();
  });

  it('marks a staged spelling upgrade', async () => {
    expect(await loadLesson(plan('staged', 'cw-0004', { itemId: 'core:cw-0004', upgrade: true }))).toMatchObject({ kind: 'staged', upgrade: true });
  });
});

describe('learnedItem', () => {
  it('names the card the memory pass retrieves: the write card for kanji and kana', () => {
    const kanji = learnedItem(plan('kanji', '水', { anchor: 'word:w-mizu' }),
      [result('kanji:水', 'kanji', ['write', 'meaning']), result('word:w-mizu', 'word', ['read'])]);
    expect(kanji.memoryCardId).toBe('kanji:水|write');
    expect(kanji.itemIds).toEqual(['kanji:水', 'word:w-mizu']);
    expect(kanji.cardIds).toEqual(['kanji:水|write', 'kanji:水|meaning', 'word:w-mizu|read']);
  });

  it('uses a core word’s produce card, or its listen card when it has none', () => {
    expect(learnedItem(plan('core', 'cw-0001'), [result('core:cw-0001', 'core', ['listen', 'produce'])]).memoryCardId).toBe('core:cw-0001|produce');
    expect(learnedItem(plan('core', 'cw-0003'), [result('core:cw-0003', 'core', ['listen'])]).memoryCardId).toBe('core:cw-0003|listen');
  });

  it('retrieves nothing for rules, grammar and staged words, and never a card already reviewed', () => {
    expect(learnedItem(plan('grammar', 'wa-desu'), [result('grammar:wa-desu', 'grammar', ['comprehend'])]).memoryCardId).toBeUndefined();
    const old = learnedItem(plan('kanji', '水'), [result('kanji:水', 'kanji', ['write'], 3)]);
    expect(old.cardIds).toEqual([]);
    expect(old.memoryCardId).toBeUndefined();
  });
});

describe('youCanNow', () => {
  it('leads with kanji and their anchor words, then grammar', async () => {
    expect(await youCanNow(['kanji:休', 'grammar:tai', 'core:cw-0001'])).toBe('You can now write 休 and read 休み and use 〜たい (want to).');
  });

  it('names today’s kana words, or the kana themselves, and core words', async () => {
    expect(await youCanNow(['kana:あ', 'kana:い'], ['あい', 'いえ', 'あお'])).toBe('You can now read あい and いえ.');
    expect(await youCanNow(['kana:あ', 'kana:い'])).toBe('You can now read あ and い.');
    expect(await youCanNow(['core:cw-0001', 'core:cw-0005'])).toBe('You can now say ありがとう and のむ.');
    expect(await youCanNow([])).toBeUndefined();
  });
});

describe('KanjiLesson', () => {
  it('starts an inferable kanji with a pre-guess from its parts, then the lesson', async () => {
    const data = (await loadLesson(plan('kanji', '休'))) as Extract<LessonData, { kind: 'kanji' }>;
    render(<KanjiLesson data={data} onHookChange={() => {}} onPractice={() => {}} />);
    expect(screen.getByRole('heading', { name: 'What might it mean?' })).toBeTruthy();
    expect(screen.getByText('person (side)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(screen.getByRole('heading', { name: 'rest' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Trace it/ })).toBeTruthy();
  });

  it('shows the anchor with its sound hook, and a guided copy when no part is new', async () => {
    const data = (await loadLesson(plan('kanji', '水'))) as Extract<LessonData, { kind: 'kanji' }>;
    render(<KanjiLesson data={data} onHookChange={() => {}} onPractice={() => {}} />);
    expect(screen.queryByRole('heading', { name: 'What might it mean?' })).toBeNull();
    expect(screen.getByText('A stream splashing drops to both sides: water.')).toBeTruthy();
    expect(screen.getByText('Me-zoo drinks water.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Listen to みず' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy it/ })).toBeTruthy();
  });

  it('allows the same memory-hook length as the kanji page (200 characters)', () => {
    expect(MNEMONIC_MAX).toBe(200);
    render(<MemoryHook text="A splash." onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory hook' }));
    expect(screen.getByLabelText('Your memory hook').getAttribute('maxlength')).toBe('200');
  });

  it('moves focus into the hook editor and back to Edit when it closes', () => {
    render(<MemoryHook text="A splash." onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit memory hook' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Your memory hook'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit memory hook' }));
  });
});

describe('word lessons', () => {
  it('plays a core word first and shows its text after a pause', async () => {
    vi.useFakeTimers();
    const core = (await loadLesson(plan('core', 'cw-0002'))) as Extract<LessonData, { kind: 'core' }>;
    render(<CoreWordLesson word={core.word} display={core.display} onNext={() => {}} />);
    expect(screen.getByText('Listen first')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'to eat' })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(LISTEN_FIRST_MS);
    });
    expect(screen.getByRole('heading', { name: 'to eat' })).toBeTruthy();
    expect(screen.getByText('Casual: with your partner and friends.')).toBeTruthy();
  });

  it('shows a spelling upgrade as the written form of a word known by ear', async () => {
    const staged = (await loadLesson(plan('staged', 'cw-0004', { itemId: 'core:cw-0004', upgrade: true }))) as Extract<LessonData, { kind: 'staged' }>;
    render(<StagedWordLesson word={staged.word} upgrade onNext={() => {}} />);
    expect(screen.getByText('New spelling')).toBeTruthy();
    expect(document.querySelector('.st-upgrade')?.textContent).toBe('You know げんき — here is how it is written:');
    expect(document.querySelector('.st-lesson-word rt')?.textContent).toBe('げんき');
  });
});

describe('KanaRuleLesson', () => {
  it('plays every pair from its kana clip, then each practice word after reading it', () => {
    const onDone = vi.fn();
    render(<KanaRuleLesson rule={KANA_RULES[0]} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'か becomes が. Listen' }));
    expect(audioMock.play).toHaveBeenLastCalledWith({ ref: 'kana:が' }, { fallbackText: 'が' });
    fireEvent.click(screen.getByRole('button', { name: 'Read some words' }));
    expect(screen.queryByText('key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hear かぎ' }));
    expect(audioMock.play).toHaveBeenLastCalledWith({ ref: 'kanaRule:hira-dakuten#0' }, { fallbackText: 'かぎ' });
    expect(screen.getByText('key')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe('MemoryPass', () => {
  const eat = () => learnedItem(plan('core', 'cw-0002'), [result('core:cw-0002', 'core', ['listen', 'produce'])]);

  it('asks a core word from English, typed, and counts one retrieval of its produce card', async () => {
    const onRetrieved = vi.fn();
    const onDone = vi.fn();
    render(<MemoryPass items={[eat()]} onRetrieved={onRetrieved} onDone={onDone} />);
    expect(await screen.findByText('to eat')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Say it' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'taberu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByText('Yes.')).toBeTruthy();
    expect(onRetrieved).toHaveBeenCalledExactlyOnceWith('core:cw-0002|produce');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('lets the word be said: a mishearing is only a retry, a match counts', async () => {
    vi.mocked(recognitionAvailable).mockReturnValue(true);
    const onRetrieved = vi.fn();
    render(<MemoryPass items={[eat()]} onRetrieved={onRetrieved} onDone={() => {}} />);
    vi.mocked(listen).mockReturnValueOnce({ result: Promise.resolve('飲む'), stop: vi.fn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Say it' }));
    expect(await screen.findByText("Didn't catch that. Try once more, or type it.")).toBeTruthy();
    expect(onRetrieved).not.toHaveBeenCalled();
    vi.mocked(listen).mockReturnValueOnce({ result: Promise.resolve('食べる'), stop: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Say it' }));
    expect(await screen.findByText('Yes.')).toBeTruthy();
    expect(onRetrieved).toHaveBeenCalledExactlyOnceWith('core:cw-0002|produce');
  });
});
