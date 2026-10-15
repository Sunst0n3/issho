// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkContent,
  checkGrammarSet,
  detectContentKind,
  itemKanji,
  kanaReadableBy,
  mergeContent,
  readContentSources,
  readingMismatches,
  readingsAgree,
  unlockOf,
} from './lib/content.ts';

const examples = [
  ['{私|わたし}は{学生|がくせい}です。', 'I am a student.'],
  ['これは{本|ほん}です。', 'This is a book.'],
  ['あれは{山|やま}です。', 'That is a mountain.'],
  ['それはペンです。', 'That is a pen.'],
  ['つまはせんせいです。', 'My wife is a teacher.'],
  ['ここはえきです。', 'This is the station.'],
  ['きょうはやすみです。', 'Today is a day off.'],
  ['わたしはエマです。', "I'm Emma."],
].map(([jp, en]) => ({ jp, en }));

const build = (jp: string, tiles: string[], alternatives: string[] = []) => ({ en: 'x', jp, tiles, alternatives });

const grammarPoint = {
  id: 'wa-desu',
  order: 1,
  level: 'N5',
  title: 'X は Y です',
  pattern: '〜は〜です',
  register: 'polite',
  prerequisites: [],
  contrastWith: [],
  explanation: 'Says what something is.',
  examples,
  buildItems: [
    build('これは{本|ほん}です。', ['これ', 'は', '本', 'です。']),
    build('わたしはエマです。', ['わたし', 'は', 'エマ', 'です。'], ['エマです。']),
    build('ここはえきです。', ['ここ', 'は', 'えき', 'です。']),
    build('つまはせんせいです。', ['つま', 'は', 'せんせい', 'です。']),
  ],
  drills: [
    { prompt: 'これ＿＿{本|ほん}です。', options: ['は', 'を', 'に'], answer: 0, en: 'This is a book.' },
    { prompt: 'それ＿＿ペンです。', options: ['は', 'が'], answer: 0, en: 'That is a pen.' },
    { prompt: '{私|わたし}＿＿{学生|がくせい}です。', options: ['は', 'を', 'で'], answer: 0, en: 'I am a student.' },
    { prompt: 'あれ＿＿{山|やま}です。', options: ['は', 'を', 'で'], answer: 0, en: 'That is a mountain.' },
  ],
};

function coreWord(extra: Record<string, unknown>) {
  return { id: 'cw-0001', order: 1, kana: 'みず', en: 'water', pos: 'noun', register: 'both', topic: 'drink', use: true, ...extra };
}

describe('checkContent', () => {
  it('accepts a valid grammar point and collects its Japanese fields', () => {
    const report = checkContent('grammar', [grammarPoint]);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.items).toHaveLength(1);
    expect(itemKanji(report.items[0])).toEqual(['私', '学', '生', '本', '山']);
  });

  it('reports bad ruby, duplicate ids, short points, tiles and drill problems with their location', () => {
    const bad = {
      ...grammarPoint,
      examples: [{ jp: '私は{学生|がくせい}です。', en: 'I am a student.' }],
      buildItems: [build('これは{本|ほん}です。', ['これ', 'が', '本', 'です。'])],
      drills: [
        { prompt: 'これは{本|ほん}です。', options: ['は', '本'], answer: 2, en: 'x' },
        { prompt: '{山|yama}＿＿', options: ['は', 'は'], answer: 0, en: 'x' },
      ],
    };
    const { errors } = checkContent('grammar', [grammarPoint, bad]);
    expect(errors).toEqual([
      '[1]: duplicate id "wa-desu"',
      '[1] wa-desu: has 1 examples (at least 8)',
      '[1] wa-desu.examples[0].jp: kanji "私" has no reading in "私は{学生|がくせい}です。"',
      '[1] wa-desu: has 1 build items (at least 4)',
      '[1] wa-desu.buildItems[0]: tiles "これ|が|本|です。" do not join to "これは本です。"',
      '[1] wa-desu: has 2 drills (at least 4)',
      '[1] wa-desu.drills[0]: prompt must have one blank "＿＿"',
      '[1] wa-desu.drills[0]: option "本" must be plain kana',
      '[1] wa-desu.drills[0]: "answer" 2 is not an index into its 2 options',
      '[1] wa-desu.drills[1].prompt: reading "yama" for "山" is not kana in "{山|yama}＿＿"',
      '[1] wa-desu.drills[1]: options must be distinct',
    ]);
  });

  it('lets a recognition-only point go without build items', () => {
    const passive = { ...grammarPoint, id: 'passive', recognitionOnly: true, buildItems: [] };
    expect(checkContent('grammar', [passive]).errors).toEqual([]);
  });

  it('checks the shape of every content kind', () => {
    expect(checkContent('sentences', { jp: 'x' }).errors).toEqual(['file: must be an array of sentences']);
    expect(checkContent('sentences', [{ id: 's-1', jp: '{水|みず}', en: 'water', grammar: [3] }]).errors).toEqual([
      '[0] s-1: "grammar" must list grammar point ids',
    ]);
    expect(checkContent('core-words', [coreWord({})]).errors).toEqual([]);
    expect(checkContent('core-words', [coreWord({ kana: '有難う' })]).errors).toEqual([
      '[0] cw-0001: "kana" must be kana only, got "有難う"',
    ]);
    expect(checkContent('mnemonics', { 水: 'Water drips down.', 氵: '' }).errors).toEqual([
      '"氵": memory hook must be a non-empty string',
    ]);
    expect(checkContent('mnemonics', { 水: { meaning: 'Water drips down.', sound: 'Me, zoo.' } }).errors).toEqual([]);
    expect(checkContent('mnemonics', { 水: { sound: 'x' } }).errors).toEqual(['"水": "meaning" must be a non-empty string']);
    const roleplay = {
      id: 'rp-1',
      title: 'Café',
      titleJp: 'カフェ',
      level: 4,
      setting: 'A café.',
      register: 'polite',
      targets: [],
      roles: { a: { name: 'Guest', nameJp: '{客|きゃく}' }, b: { name: 'Staff', nameJp: '{店員|てんいん}' } },
      lines: [{ role: 'c', jp: 'コーヒー', en: 'Coffee', cue: '' }],
    };
    expect(checkContent('roleplays', [roleplay]).errors).toEqual([
      '[0] rp-1: "level" must be one of 1, 2, 3',
      '[0] rp-1.lines[0]: "role" must be one of "a", "b"',
    ]);
    const { register: _register, targets: _targets, ...v1 } = roleplay;
    expect(checkContent('roleplays', [{ ...v1, level: 1, lines: [{ role: 'a', jp: 'コーヒー', en: 'Coffee' }] }], true).errors).toEqual([]);
    expect(checkContent('confusables', [{ id: 'v-x', chars: ['未', '末', 'a'], kind: 'visual' }]).errors).toEqual([
      '[0] v-x: "a" must be one kanji',
    ]);
  });

  it('checks the kana rules: ids, days, pairs and practice words readable by their day', () => {
    const rule = {
      id: 'hira-dakuten',
      day: 6,
      title: 'Voiced sounds',
      explanation: 'Two marks.',
      pairs: [{ from: 'か', to: 'が', romaji: 'ga' }],
      practiceWords: ['がっこう', 'かぎ', 'ごはん', 'ぎんこう', 'かぜ', 'ひざ', 'みず', 'ぶた'].map((kana) => ({ kana, en: 'x' })),
    };
    const report = checkContent('kana-rules', [rule]);
    expect(report.errors).toEqual([]);
    // ぎ ご ぜ ざ ず ぶ are not paired by this one-pair rule.
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(checkContent('kana-rules', [{ ...rule, day: 7 }]).errors).toEqual(['[0] hira-dakuten: "day" must be 6']);
    expect(kanaReadableBy(1, []).has('か')).toBe(true);
    expect(kanaReadableBy(1, []).has('さ')).toBe(false);
    expect(kanaReadableBy(6, [rule]).has('が')).toBe(true);
  });
});

describe('checkGrammarSet', () => {
  it('needs 110 points, earlier acyclic prerequisites and known contrasts', () => {
    const points = [
      { id: 'a', order: 1, prerequisites: [], contrastWith: ['z'] },
      { id: 'b', order: 2, prerequisites: ['c'], contrastWith: [] },
      { id: 'c', order: 3, prerequisites: ['b', 'x'], contrastWith: [] },
    ];
    expect(checkGrammarSet(points).errors).toEqual([
      'grammar-v2 has 3 points (at least 110)',
      'a: contrastWith "z" does not exist',
      'b: prerequisite "c" (#3) does not come before it (#2)',
      'c: prerequisite "x" does not exist',
      'prerequisite cycle: b → c → b',
    ]);
  });
});

describe('mergeContent', () => {
  const s1 = [
    { id: 's-1', jp: '{水|みず}', en: 'water' },
    { id: 's-2', jp: '{火|ひ}', en: 'fire' },
  ];

  it('concatenates the files in order and prefixes their messages', () => {
    const merged = mergeContent('sentences', [
      { file: 'content/sentences/s1.json', data: s1 },
      { file: 'content/sentences/s2.json', data: [{ id: 's-3', jp: '水', en: 'water' }] },
    ]);
    expect((merged.data as { id: string }[]).map((s) => s.id)).toEqual(['s-1', 's-2', 's-3']);
    expect(merged.items.map((i) => i.id)).toEqual(['s-1', 's-2', 's-3']);
    expect(merged.errors).toEqual(['content/sentences/s2.json [0] s-3.jp: kanji "水" has no reading in "水"']);
  });

  it('reports an id used by two files', () => {
    const { errors } = mergeContent('sentences', [
      { file: 'a.json', data: s1 },
      { file: 'b.json', data: [{ id: 's-2', jp: 'みず', en: 'water' }] },
    ]);
    expect(errors).toEqual(['b.json: id "s-2" is also used in a.json']);
  });

  it('reads a file holding one entry as a list of one, and sorts core words by order', () => {
    const merged = mergeContent('core-words', [
      { file: 'part2.json', data: coreWord({ id: 'cw-0002', order: 2, kana: 'ひ' }) },
      { file: 'part1.json', data: [coreWord({})] },
    ]);
    expect(merged.errors).toEqual([]);
    expect((merged.data as { id: string }[]).map((w) => w.id)).toEqual(['cw-0001', 'cw-0002']);
  });

  it('combines mnemonic maps', () => {
    const merged = mergeContent('mnemonics', [
      { file: 'a.json', data: { 水: 'Drops.' } },
      { file: 'b.json', data: { 火: 'Sparks.', 水: 'Again.' } },
    ]);
    expect(merged.data).toEqual({ 水: 'Again.', 火: 'Sparks.' });
    expect(merged.errors).toEqual(['b.json: id "水" is also used in a.json']);
  });
});

describe('readContentSources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issho-content-'));
  const content = join(dir, 'content');
  const write = (path: string, data: unknown) => {
    mkdirSync(join(content, path, '..'), { recursive: true });
    writeFileSync(join(content, path), typeof data === 'string' ? data : JSON.stringify(data));
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads every *.json of a folder by file name, ignoring other files', () => {
    write('stories/st-2.json', { id: 'st-2' });
    write('stories/st-10.json', [{ id: 'st-10' }]);
    write('stories/notes.txt', 'not json');
    const set = readContentSources(content, 'stories', dir);
    expect(set.label).toBe('content/stories');
    expect(set.sources.map((s) => s.file)).toEqual(['content/stories/st-2.json', 'content/stories/st-10.json']);
    expect(set.errors).toEqual([]);
  });

  it('lets a units/ or roleplays-v2/ folder win over the single file, naming the ids that differ', () => {
    write('units/u01.json', { id: 1, title: 'New' });
    write('units/u02.json', { id: 2, title: 'Two' });
    write('units.json', [{ id: 1, title: 'Old' }, { id: 2, title: 'Two' }, { id: 3, title: 'Gone' }]);
    const set = readContentSources(content, 'units', dir);
    expect(set.sources.map((s) => s.file)).toEqual(['content/units/u01.json', 'content/units/u02.json']);
    expect(set.warnings).toEqual([
      'content/units.json is ignored because content/units/ exists; 1 differ (1); only in the file: 3',
    ]);
    expect(set.notes).toEqual([]);
  });

  it('only notes a single file that holds the same content as its folder', () => {
    write('units/u01.json', { id: 1, title: 'One' });
    write('units/u02.json', { id: 2, title: 'Two' });
    write('units.json', [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }]);
    const set = readContentSources(content, 'units', dir);
    expect(set.sources.map((s) => s.file)).toEqual(['content/units/u01.json', 'content/units/u02.json']);
    expect(set.warnings).toEqual([]);
    expect(set.notes).toEqual(['content/units.json is ignored because content/units/ exists (same content)']);
  });

  it('prefers the single core-words.json over its part files, and falls back to the parts', () => {
    write('core-words/part1.json', [coreWord({})]);
    expect(readContentSources(content, 'core-words', dir).sources.map((s) => s.file)).toEqual(['content/core-words/part1.json']);
    write('core-words.json', [coreWord({})]);
    expect(readContentSources(content, 'core-words', dir).sources.map((s) => s.file)).toEqual(['content/core-words.json']);
  });

  it('falls back to v1 roleplays.json, and publishes a missing kind empty with a warning', () => {
    write('roleplays.json', []);
    const v1 = readContentSources(content, 'roleplays', dir);
    expect(v1).toMatchObject({ v1: true, label: 'content/roleplays.json', missing: false });
    const missing = readContentSources(content, 'confusables', dir);
    expect(missing).toMatchObject({ missing: true, sources: [] });
    expect(missing.warnings).toEqual(['content/confusables.json is missing; publishing it empty']);
  });

  it('reports bad JSON as an error', () => {
    write('kana-rules.json', '[{');
    expect(readContentSources(content, 'kana-rules', dir).errors[0]).toMatch(/^content\/kana-rules\.json is not valid JSON/);
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

  it('accepts a number and counter read together', () => {
    const withGobu = new Map([
      ...readings,
      ['五分', ['ごぶ']],
      ['一本', ['いっぽん']],
      ['四時', ['よじ', 'しじ']],
      ['三日', ['みっか']],
    ]);
    const flagged = (jp: string) =>
      readingMismatches(checkContent('sentences', [{ id: 's', jp, en: 'x' }]).items[0], withGobu).map((m) => m.reading);
    expect(flagged('{五分|ごふん}')).toEqual([]);
    expect(flagged('{一本|いっぽん}')).toEqual([]);
    expect(flagged('{五分|ごふ}')).toEqual(['ごふ']);
    // The counter rules never overrule the dictionary on a set reading.
    expect(flagged('{四時|よんじ}')).toEqual(['よんじ']);
    expect(flagged('{三日|さんにち}')).toEqual(['さんにち']);
    expect(flagged('{二|に}、{三日|さんにち}')).toEqual([]);
  });

  it('completes okurigana only to the given words', () => {
    const jmdict = new Map([...readings, ['今日', ['きょう', 'こんにち']], ['今日は', ['こんにちは']]]);
    const [item] = checkContent('sentences', [{ id: 's', jp: '{今日|きょう}は{雨|あめ}', en: 'x' }]).items;
    expect(readingMismatches(item, jmdict).map((m) => m.written)).toEqual(['今日は']);
    expect(readingMismatches(item, jmdict, new Set(['今日']))).toEqual([]);
  });

  it('compares a core word with its written form', () => {
    const [item] = checkContent('core-words', [coreWord({ id: 'cw-1', kana: 'よん', written: '四', en: 'four' })]).items;
    expect(readingMismatches(item, readings).map((m) => m.path)).toEqual(['[0] cw-1.written']);
  });
});

describe('detectContentKind', () => {
  it('uses the file name or folder, then the shape of the data', () => {
    expect(detectContentKind('content/grammar-v2.json', [])).toBe('grammar');
    expect(detectContentKind('content/core-words/part1.json', [])).toBe('core-words');
    expect(detectContentKind('content/units/u03.json', {})).toBe('units');
    expect(detectContentKind('content/stories/st-l0-07.json', {})).toBe('stories');
    expect(detectContentKind('content/roleplays-v2/rp-u01.json', {})).toBe('roleplays');
    expect(detectContentKind('/tmp/draft-sentences.json', [])).toBe('sentences');
    expect(detectContentKind('content/kana-rules.json', [])).toBe('kana-rules');
    expect(detectContentKind('content/confusables.json', [])).toBe('confusables');
    expect(detectContentKind('draft.json', { 水: 'x' })).toBe('mnemonics');
    expect(detectContentKind('draft.json', { 水: { meaning: 'x' } })).toBe('kana-examples');
    expect(detectContentKind('draft.json', [{ id: 'r', lines: [] }])).toBe('roleplays');
    expect(detectContentKind('draft.json', [{ id: 'w', kana: 'あ', pos: 'noun' }])).toBe('core-words');
    expect(detectContentKind('draft.json', { id: 3, coreWordCeiling: 300 })).toBe('units');
    expect(detectContentKind('draft.json', [{ id: 's', jp: 'あ' }])).toBe('sentences');
    expect(detectContentKind('draft.json', [1])).toBeUndefined();
  });
});
