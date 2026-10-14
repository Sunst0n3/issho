// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  checkContent,
  detectContentKind,
  itemKanji,
  readingMismatches,
  readingsAgree,
  unlockOf,
} from './lib/content.ts';

const grammarPoint = {
  id: 'wa-desu',
  order: 1,
  phase: 1,
  title: 'X は Y です',
  pattern: '〜は〜です',
  explanation: 'Says what something is.',
  examples: [
    { jp: '{私|わたし}は{学生|がくせい}です。', en: 'I am a student.' },
    { jp: 'これは{本|ほん}です。', en: 'This is a book.' },
    { jp: 'あれは{山|やま}です。', en: 'That is a mountain.' },
  ],
  drills: [
    { prompt: 'これ＿＿{本|ほん}です。', options: ['は', 'を', 'に'], answer: 0, en: 'This is a book.' },
    { prompt: 'それ＿＿ペンです。', options: ['は', 'が'], answer: 0, en: 'That is a pen.' },
    { prompt: '{私|わたし}＿＿{学生|がくせい}です。', options: ['は', 'を', 'で'], answer: 0, en: 'I am a student.' },
    { prompt: 'あれ＿＿{山|やま}です。', options: ['は', 'を', 'で'], answer: 0, en: 'That is a mountain.' },
  ],
};

describe('checkContent', () => {
  it('accepts a valid grammar point and collects its Japanese fields', () => {
    const report = checkContent('grammar', [grammarPoint]);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.items).toHaveLength(1);
    expect(itemKanji(report.items[0])).toEqual(['私', '学', '生', '本', '山']);
  });

  it('reports bad ruby, duplicate ids and drill problems with their location', () => {
    const bad = {
      ...grammarPoint,
      examples: [{ jp: '私は{学生|がくせい}です。', en: 'I am a student.' }],
      drills: [
        { prompt: 'これは{本|ほん}です。', options: ['は', '本'], answer: 2, en: 'x' },
        { prompt: '{山|yama}＿＿', options: ['は', 'は'], answer: 0, en: 'x' },
      ],
    };
    const { errors, warnings } = checkContent('grammar', [grammarPoint, bad]);
    expect(errors).toEqual([
      '[1]: duplicate id "wa-desu"',
      '[1] wa-desu.examples[0].jp: kanji "私" has no reading in "私は{学生|がくせい}です。"',
      '[1] wa-desu.drills[0]: prompt has no blank "＿＿"',
      '[1] wa-desu.drills[0]: option "本" must be plain kana',
      '[1] wa-desu.drills[0]: "answer" 2 is not an index into its 2 options',
      '[1] wa-desu.drills[1].prompt: reading "yama" for "山" is not kana in "{山|yama}＿＿"',
      '[1] wa-desu.drills[1]: options must be distinct',
    ]);
    expect(warnings).toEqual(['[1] wa-desu: has 1 examples (3+ expected)', '[1] wa-desu: has 2 drills (4+ expected)']);
  });

  it('checks the shape of every content kind', () => {
    expect(checkContent('sentences', { jp: 'x' }).errors).toEqual(['file: must be an array of sentences']);
    expect(checkContent('sentences', [{ id: 's-1', jp: '{水|みず}', en: 'water', grammar: [3] }]).errors).toEqual([
      '[0] s-1: "grammar" must list grammar point ids',
    ]);
    expect(checkContent('survival-words', [{ id: 'sw-1', kana: 'ありがとう', en: 'thanks' }]).errors).toEqual([]);
    expect(checkContent('survival-words', [{ id: 'sw-1', kana: '有難う', en: 'thanks' }]).errors).toEqual([
      '[0] sw-1: "kana" must be kana only, got "有難う"',
    ]);
    expect(checkContent('mnemonics', { 水: 'Water drips down.', 氵: '' }).errors).toEqual([
      '"氵": memory hook must be a non-empty string',
    ]);
    const roleplay = {
      id: 'rp-1',
      title: 'Café',
      titleJp: 'カフェ',
      level: 4,
      setting: 'A café.',
      roles: { a: { name: 'Guest', nameJp: '{客|きゃく}' }, b: { name: 'Staff', nameJp: '{店員|てんいん}' } },
      lines: [{ role: 'c', jp: 'コーヒー', en: 'Coffee' }],
    };
    expect(checkContent('roleplays', [roleplay]).errors).toEqual([
      '[0] rp-1: "level" must be one of 1, 2, 3',
      '[0] rp-1.lines[0]: "role" must be one of "a", "b"',
    ]);
  });
});

describe('unlock index', () => {
  const unitIndex = new Map([
    ['日', 0],
    ['本', 3],
    ['氵', 5],
    ['語', 40],
  ]);

  it('is the highest unit among the kanji, listing kanji nobody teaches', () => {
    const [item] = checkContent('sentences', [{ id: 's', jp: '{日本語|にほんご}を{話|はな}す', en: 'x' }]).items;
    expect(unlockOf(item, unitIndex)).toEqual({ index: 40, char: '語', missing: ['話'] });
  });

  it('is -1 for kana-only text and uses mnemonic keys directly', () => {
    const [kana] = checkContent('sentences', [{ id: 's', jp: 'ありがとう', en: 'x' }]).items;
    expect(unlockOf(kana, unitIndex)).toEqual({ index: -1, missing: [] });
    const [hook] = checkContent('mnemonics', { 氵: 'Three drops of water.' }).items;
    expect(unlockOf(hook, unitIndex)).toMatchObject({ index: 5, char: '氵' });
  });
});

describe('reading mismatches', () => {
  const readings = new Map<string, string[]>([
    ['明日', ['あした']],
    ['行', ['ぎょう']],
    ['行く', ['いく']],
    ['飯', ['めし']],
    ['ご飯', ['ごはん']],
    ['係', ['かかり']],
    ['一', ['いち']],
    ['四', ['し']],
  ]);
  const check = (jp: string) =>
    readingMismatches(checkContent('sentences', [{ id: 's', jp, en: 'x' }]).items[0], readings).map(
      (m) => `${m.written}:${m.reading}`,
    );

  it('flags a whole-word base read differently from words.json', () => {
    expect(check('{明日|みょうにち}')).toEqual(['明日:みょうにち']);
    expect(check('{明日|あした}')).toEqual([]);
  });

  it('checks okurigana and honorific prefixes as part of the word', () => {
    expect(check('{行|い}く')).toEqual([]);
    expect(check('{行|ゆ}く')).toEqual(['行く:ゆく']);
    expect(check('ご{飯|はん}')).toEqual([]);
  });

  it('skips single kanji whose okurigana are unknown or blanked out', () => {
    expect(check('{行|い}きます')).toEqual([]);
    expect(check('{行|い}＿＿')).toEqual([]);
    expect(check('{行|い}。')).toEqual(['行:い']);
  });

  it('allows rendaku and gemination', () => {
    expect(readingsAgree('がかり', 'かかり')).toBe(true);
    expect(readingsAgree('いっ', 'いち')).toBe(true);
    expect(readingsAgree('ガカリ', 'かかり')).toBe(true);
    expect(readingsAgree('よん', 'し')).toBe(false);
    expect(check('{受付|うけつけ}{係|がかり}と{一|いっ}{回|かい}')).toEqual([]);
  });

  it('compares a survival word with its written form', () => {
    const [item] = checkContent('survival-words', [{ id: 'sw', kana: 'よん', written: '四', en: 'four' }]).items;
    expect(readingMismatches(item, readings).map((m) => m.path)).toEqual(['[0] sw.written']);
  });
});

describe('detectContentKind', () => {
  it('uses the file name, then the shape of the data', () => {
    expect(detectContentKind('content/grammar.json', [])).toBe('grammar');
    expect(detectContentKind('/tmp/draft-sentences.json', [])).toBe('sentences');
    expect(detectContentKind('draft.json', { 水: 'x' })).toBe('mnemonics');
    expect(detectContentKind('draft.json', [{ id: 'r', lines: [] }])).toBe('roleplays');
    expect(detectContentKind('draft.json', [{ id: 'w', kana: 'あ' }])).toBe('survival-words');
    expect(detectContentKind('draft.json', [{ id: 's', jp: 'あ' }])).toBe('sentences');
    expect(detectContentKind('draft.json', [1])).toBeUndefined();
  });
});
