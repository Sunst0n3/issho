import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import type { CardRecord, ItemRecord } from '../../../lib/types.ts';
import type { NewItemPlan } from '../../../srs/course.ts';
import type { IntroduceResult } from '../../../srs/items.ts';
import { listen, recognitionAvailable } from '../../../speech/recognition.ts';
import { audioMock, CURRICULUM, GRAMMAR, KANA, KANA_RULES, resetStudyDb } from '../test-utils.tsx';
import { CoreWordLesson, LISTEN_FIRST_MS } from './CoreWordLesson.tsx';
import { grammarPhrase, kanaSoundRow, learnedItem, loadLesson, wordRuby, youCanNow, type LessonData } from './data.ts';
import { BuildPractice } from './GrammarLesson.tsx';
import { KanaRuleLesson } from './KanaRuleLesson.tsx';
import { KanjiLesson, MemoryHook, MNEMONIC_MAX } from './KanjiLesson.tsx';
import { MemoryPass } from './MemoryPass.tsx';
import { copyPasses } from './NewItemFlow.tsx';
import { Readings } from './Readings.tsx';
import { StagedWordLesson } from './StagedWordLesson.tsx';
import { LESSON_PASSES } from './WriteSteps.tsx';

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
    // 本 is 木 and strokes the parts list doesn't name: 木 was introduced, so a guided copy only.
    k = (await loadLesson(plan('kanji', '本'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.newPart).toBe(false);
    expect(copyPasses(k)).toEqual(['guided']);
    // The anchor and the hook come from the curriculum and the mnemonics.
    k = (await loadLesson(plan('kanji', '水'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.anchor?.ref).toBe('word:w-mizu');
    expect(k.mnemonic?.sound).toBe('Me-zoo drinks water.');
    expect(k.anchorAccent?.type).toBe('heiban');
  });

  it('traces a kanji with no listed parts (日, 一, 人) until an earlier lesson\'s kanji contained it', async () => {
    let k = (await loadLesson(plan('kanji', '日'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.parts).toEqual([]);
    expect(k.newPart).toBe(true);
    expect(copyPasses(k)).toEqual(LESSON_PASSES);
    // 曜 has 日 as a component: its shape was already met in that lesson.
    await introduced('kanji', '曜');
    k = (await loadLesson(plan('kanji', '日'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.newPart).toBe(false);
    // Its own introduction doesn't count as an earlier lesson.
    await resetStudyDb();
    await introduced('kanji', '日');
    k = (await loadLesson(plan('kanji', '日'))) as Extract<LessonData, { kind: 'kanji' }>;
    expect(k.newPart).toBe(true);
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
  it('leads with kanji and their anchor words, then grammar and core words', async () => {
    expect(await youCanNow(['kanji:休', 'word:w-yasumi'])).toBe('You can now write 休 and read 休み.');
    expect(await youCanNow(['kanji:休', 'word:w-yasumi', 'grammar:tai', 'core:cw-0001']))
      .toBe('You can now write 休, read 休み, use 〜たい (want to), and say ありがとう.');
  });

  it('names today’s kana words, or the kana themselves, and core words', async () => {
    expect(await youCanNow(['kana:あ', 'kana:い'], ['あい', 'いえ', 'あお', 'いい'])).toBe('You can now read あい, いえ and あお.');
    expect(await youCanNow(['kana:あ', 'kana:い'])).toBe('You can now read あ and い.');
    expect(await youCanNow(['core:cw-0001', 'core:cw-0005'])).toBe('You can now say ありがとう and のむ.');
    expect(await youCanNow([])).toBeUndefined();
  });

  it('names every kanji, reads anchors and staged words, and says only the new core words', async () => {
    // 食's anchor is a core word, introduced with it; げんき (元気) is a staged word released today.
    CURRICULUM.units.push({ index: 7, char: '食', anchor: 'core:cw-0002', staged: [], inferable: false, chapter: 1 });
    try {
      await db.items.put({ id: 'core:cw-0004', kind: 'core', key: 'cw-0004', introducedAt: new Date(), via: 'staged' });
      const ids = ['kanji:水', 'word:w-mizu', 'kanji:休', 'word:w-yasumi', 'kanji:食', 'core:cw-0002', 'core:cw-0004',
        'core:cw-0001', 'core:cw-0005', 'core:cw-0006'];
      expect(await youCanNow(ids))
        .toBe('You can now write 水, 休 and 食, read 休み, 食べる and 元気, and say ありがとう, のむ and みる.');
      // Two kanji and one anchor: the clause lists stay apart.
      expect(await youCanNow(['kanji:水', 'kanji:休', 'word:w-yasumi'])).toBe('You can now write 水 and 休, and read 休み.');
    } finally {
      CURRICULUM.units.pop();
    }
  });

  it('names a grammar point by its short pattern with whole quotes', async () => {
    const point = (title: string, pattern: string) => ({ ...GRAMMAR[2], title, pattern });
    expect(grammarPhrase(point('〜と — "and", "with"', '〜と〜・〜と{一緒|いっしょ}に'))).toBe('〜と ("and", "with")');
    expect(grammarPhrase(point('あります・います — "there is", "I have"', '〜に〜があります・〜がいます')))
      .toBe('あります・います ("there is", "I have")');
    expect(grammarPhrase(point('〜は〜です — "X is Y"', '〜は〜です'))).toBe('〜は〜です (X is Y)');
    expect(grammarPhrase(point('〜で — where and how', '〜で'))).toBe('〜で (where and how)');
    expect(grammarPhrase(point('AかB・〜にします — "A or B", "I\'ll have …"', 'AかB・〜にします')))
      .toBe('AかB・〜にします ("A or B", "I\'ll have …")');
    expect(grammarPhrase(point('Passive — "was done (to me)"', '〜れる・〜られる'))).toBe('〜れる・〜られる (passive)');
    expect(grammarPhrase(point('い-adjectives — "it\'s tasty / it\'s not tasty"', '〜いです・〜くないです')))
      .toBe('〜いです・〜くないです (い-adjectives)');
    expect(grammarPhrase(point('Describing nouns with sentences', '〜た＋N・〜る＋N'))).toBe('〜た＋N・〜る＋N (describing nouns with sentences)');
    expect(grammarPhrase(point('Dictionary form — the plain verb', '{食|た}べる・{飲|の}む'))).toBe('食べる・飲む (dictionary form)');
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
    // 水 has no listed parts and no earlier lesson contained it: its whole shape is new.
    expect(screen.getByRole('button', { name: /Trace it/ })).toBeTruthy();
    cleanup();
    await introduced('kanji', '木');
    const hon = (await loadLesson(plan('kanji', '本'))) as Extract<LessonData, { kind: 'kanji' }>;
    render(<KanjiLesson data={hon} onHookChange={() => {}} onPractice={() => {}} />);
    expect(screen.getByRole('button', { name: /Copy it/ })).toBeTruthy();
  });

  it('lists each reading once, keeping the okurigana spelling', () => {
    render(<Readings kun={['のち', 'うし.ろ', 'うしろ', 'あと', 'おく.れる']} on={['ゴ', 'コウ', '-ゴ']} />);
    const rows = [...document.querySelectorAll('.st-readings dd')].map((dd) => dd.textContent);
    expect(rows).toEqual(['のち、うしろ、あと', 'ゴ、コウ']);
    expect(document.querySelectorAll('.st-okuri')).toHaveLength(1);
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
  it('plays both sides of every pair from their kana clips, then each practice word after reading it', () => {
    const onDone = vi.fn();
    render(<KanaRuleLesson rule={KANA_RULES[0]} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hear か' }));
    expect(audioMock.play).toHaveBeenLastCalledWith({ ref: 'kana:か' }, { fallbackText: 'か' });
    fireEvent.click(screen.getByRole('button', { name: 'Hear が' }));
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

describe('BuildPractice', () => {
  it('never deals the tiles already in the answer order', () => {
    // Math.random → 0.99 keeps every Fisher–Yates swap in place: a plain shuffle would deal the answer.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      render(<BuildPractice point={GRAMMAR[0]} onDone={() => {}} />);
      const tray = [...screen.getByRole('group', { name: 'Pieces' }).querySelectorAll('button')].map((b) => b.textContent);
      expect([...tray].sort()).toEqual([...GRAMMAR[0].buildItems[0].tiles].sort());
      expect(tray).not.toEqual(GRAMMAR[0].buildItems[0].tiles);
    } finally {
      random.mockRestore();
    }
  });

  it('shows furigana on a tile over a kanji the learner has not met, as the review card does (V043)', async () => {
    const point = {
      ...GRAMMAR[0],
      buildItems: [{
        en: 'I am a student.', jp: '{私|わたし}は{学生|がくせい}です。', tiles: ['私', 'は', '学生', 'です'], alternatives: [],
        answers: ['わたしはがくせいです'],
      }],
    };
    render(<BuildPractice point={point} onDone={() => {}} />);
    const tray = screen.getByRole('group', { name: 'Pieces' });
    await vi.waitFor(() => expect([...tray.querySelectorAll('rt')].map((rt) => rt.textContent).sort()).toEqual(['がくせい', 'わたし']));
    // The tile string is still what is placed and checked.
    const tile = [...tray.querySelectorAll('button')].find((b) => b.querySelector('rt')?.textContent === 'わたし')!;
    fireEvent.click(tile);
    expect(screen.getByRole('button', { name: 'Remove 私' })).toBeTruthy();
  });
});

describe('MemoryPass', () => {
  const eat = () => learnedItem(plan('core', 'cw-0002'), [result('core:cw-0002', 'core', ['listen', 'produce'])]);
  const kanaItem = (c: string) => learnedItem(plan('kana', c), [result(`kana:${c}`, 'kana', ['read', 'write'])]);

  it('names the row of a sprint kana whose sound another kana shares (を, お), as the review card does', async () => {
    const find = (c: string) => KANA.find((k) => k.char === c)!;
    expect(kanaSoundRow(find('を'), KANA)).toBe('わ');
    expect(kanaSoundRow(find('お'), KANA)).toBe('あ');
    expect(kanaSoundRow(find('か'), KANA)).toBeUndefined();
    render(<MemoryPass items={[kanaItem('を')]} onRetrieved={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Write the hiragana you hear' })).toBeTruthy();
    expect(document.querySelector('.st-write-reading')?.textContent).toBe('(わ row)');
    cleanup();
    render(<MemoryPass items={[kanaItem('あ')]} onRetrieved={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Write the hiragana you hear' })).toBeTruthy();
    expect(document.querySelector('.st-write-reading')).toBeNull();
  });

  it('lets a kanji prompt play its anchor word, and reads its blank as "blank" (V051)', async () => {
    const item = learnedItem(plan('kanji', '日', { anchor: 'word:w-nihon' }), [result('kanji:日', 'kanji', ['write'])]);
    render(<MemoryPass items={[item]} onRetrieved={() => {}} onDone={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Write the kanji' })).toBeTruthy();
    const blanked = document.querySelector('.st-write-blanked')!;
    expect(blanked.querySelector('[aria-hidden="true"]')?.textContent).toBe('□');
    expect(blanked.querySelector('.visually-hidden')?.textContent).toBe('blank');
    fireEvent.click(screen.getByRole('button', { name: 'Listen to にほん' }));
    expect(audioMock.play).toHaveBeenLastCalledWith({ ref: 'word:w-nihon' }, { fallbackText: 'にほん' });
  });

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

  it('accepts the word typed with its kanji from a Japanese keyboard (V040)', async () => {
    const onRetrieved = vi.fn();
    render(<MemoryPass items={[eat()]} onRetrieved={onRetrieved} onDone={() => {}} />);
    expect(await screen.findByText('to eat')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: '食べる' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(screen.getByText('Yes.')).toBeTruthy();
    expect(onRetrieved).toHaveBeenCalledExactlyOnceWith('core:cw-0002|produce');
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
