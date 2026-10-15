// @vitest-environment node
// Checks for the v2 ruby tokenizer (scripts/v2/tokenize.ts) and the coverage maths in
// scripts/v2/coverage.ts. Uses the real content/core-words.json; JMdict refs need
// public/data/words.json (npm run build:data) and are only checked when it exists.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { coverageOf, detectKind, itemsOf } from './coverage.ts';
import { getTokenizer, plainText, shareReading, type RubyToken, type RubyTokenizer } from './tokenize.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hasWords = existsSync(`${ROOT}public/data/words.json`);

let tk: RubyTokenizer;
beforeAll(async () => {
  tk = await getTokenizer();
}, 30_000);

const tokens = (text: string) => tk.tokenize(text);
const content = (text: string) => tokens(text).filter((t) => t.kind === 'content');
/** Content tokens as 'surface=headword' (the core word's written form or kana), '?' when not a core word. */
const words = (text: string) =>
  content(text).map((t) => {
    const w = t.ref?.startsWith('core:') ? tk.core.get(t.ref.slice(5)) : undefined;
    return `${t.surface}=${w ? (w.written ?? w.kana) : '?'}`;
  });
const coreOrder = (t: RubyToken) => (t.ref?.startsWith('core:') ? tk.core.get(t.ref.slice(5))!.order : undefined);

describe('tokenizeRuby', () => {
  it('strips ruby and phrase marks, keeps the author readings in hiragana and numbers the phrases', () => {
    const toks = tokens('きのう／{駅|えき}の／{近|ちか}くで／ラーメンを／{食|た}べました。');
    expect(toks.map((t) => t.surface).join('')).toBe('きのう駅の近くでラーメンを食べました。');
    expect(toks.some((t) => /[{}|／]/u.test(t.surface))).toBe(false);
    const by = (s: string) => toks.find((t) => t.surface === s)!;
    expect(by('駅')).toMatchObject({ reading: 'えき', kind: 'content', phrase: 1 });
    expect(by('ラーメン')).toMatchObject({ reading: 'らーめん', phrase: 3 });
    expect(by('食べ')).toMatchObject({ lemma: '食べる', reading: 'たべ', phrase: 4 });
    expect(by('の').kind).toBe('function');
    expect(by('まし')).toMatchObject({ kind: 'function', lemma: 'ます' });
    expect(by('。').kind).toBe('punct');
    expect(words('きのう／{駅|えき}の／{近|ちか}くで／ラーメンを／{食|た}べました。')).toEqual([
      'きのう=昨日',
      '駅=駅',
      '近く=近く',
      'ラーメン=ラーメン',
      '食べ=食べる',
    ]);
  });

  it('splits a word that runs across a phrase mark into one token per phrase, keeping its ref', () => {
    for (const text of ['「よろしく／おねがいします。」', 'すみません、／ちょっと／まってください。', 'ケンは／おなかが／すきました。']) {
      const toks = tokens(text);
      const phrases = plainText(text.replace(/／/g, '\u0000')).split('\u0000');
      const byPhrase = phrases.map((_, n) => toks.filter((t) => t.phrase === n).map((t) => t.surface).join(''));
      expect(byPhrase, text).toEqual(phrases);
    }
    expect(words('「よろしく／おねがいします。」')).toEqual(['よろしく=よろしくお願いします', 'おねがいします=よろしくお願いします']);
    expect(words('ケンは／おなかが／すきました。').slice(1)).toEqual(['おなかが=お腹がすく', 'すき=お腹がすく']);
    expect(tokens('{今日|きょう}は／お{腹|なか}が／すいた').filter((t) => t.ref === tokens('おなかがすいた')[0].ref).map((t) => [t.surface, t.reading, t.phrase])).toEqual([
      ['お腹が', 'おなかが', 1],
      ['すい', 'すい', 2],
    ]);
    // Without the mark the same words stay one token.
    expect(words('よろしくおねがいします。')).toEqual(['よろしくおねがいします=よろしくお願いします']);
  });

  it.runIf(hasWords)('keeps a JMdict run inside its phrase', () => {
    const jm = (text: string) => content(text).map((t) => [t.surface, t.phrase, t.ref?.slice(0, 5)]);
    // 仕方がない is a JMdict expression; across the author's mark it reads as 仕方 + ない.
    expect(jm('{仕方|しかた}がない。')).toEqual([['仕方がない', 0, 'word:']]);
    expect(jm('{仕方|しかた}が／ない。')).toEqual([['仕方', 0, 'word:'], ['ない', 1, 'core:']]);
    // A core word wins over a longer JMdict expression: 方がいい reads as the core words 方 (ほう) + いい.
    expect(jm('スープの{方|ほう}がいい。')).toEqual([['スープ', 0, 'core:'], ['方', 0, 'core:'], ['いい', 0, 'core:']]);
  });

  it('merges compounds kuromoji splits, する-verbs and set phrases into core words', () => {
    expect(words('{昨日|きのう}の{晩|ばん}ご{飯|はん}はおいしかったです。')).toEqual(['昨日=昨日', '晩ご飯=晩ご飯', 'おいしかっ=おいしい']);
    expect(words('{毎日|まいにち}{日本語|にほんご}を{勉強|べんきょう}しています。')).toEqual(['毎日=毎日', '日本語=日本語', '勉強し=勉強する']);
    expect(words('{食|た}べ{放題|ほうだい}に{行|い}きたい')).toEqual(['食べ放題=食べ放題', '行き=行く']);
    expect(words('もう{一度|いちど}お{願|ねが}いします。')).toEqual(['もう一度お願いします=もう一度お願いします']);
    // ています: い is grammar, not the verb いる.
    expect(tokens('{勉強|べんきょう}しています').find((t) => t.surface === 'い')?.kind).toBe('function');
  });

  it('handles お/ご prefixes', () => {
    expect(words('お{茶|ちゃ}をください')).toEqual(['お茶=お茶', 'ください=ください']);
    expect(words('おしごとはなんですか。')).toEqual(['しごと=仕事', 'なん=何']);
  });

  it('lets the author’s reading choose between homographs', () => {
    expect(words('{一日|いちにち}と{一日|ついたち}')).toEqual(['一日=一日', '一日=一日']);
    const [allDay, first] = content('{一日|いちにち}と{一日|ついたち}');
    expect(tk.core.get(allDay.ref!.slice(5))!.kana).toBe('いちにち');
    expect(tk.core.get(first.ref!.slice(5))!.kana).toBe('ついたち');
    expect(tk.core.get(content('あの{人|ひと}')[1].ref!.slice(5))!.kana).toBe('ひと');
    expect(tk.core.get(content('{三人|さんにん}')[1].ref!.slice(5))!.kana).toBe('にん');
    // {十分|じゅっぷん} is ten minutes (十 + 分), not じゅうぶん "enough".
    expect(words('{駅|えき}まで{十分|じゅっぷん}です')).toEqual(['駅=駅', '十=十', '分=分']);
    expect(words('{十分|じゅうぶん}です')).toEqual(['十分=十分']);
  });

  it('shares a ruby reading out over the tokens it spans', () => {
    const [six, hundred, yen] = content('{六百|ろっぴゃく}{円|えん}です');
    expect([six.reading, hundred.reading, yen.reading]).toEqual(['ろっ', 'ぴゃく', 'えん']);
    expect(words('{六百|ろっぴゃく}{円|えん}です')).toEqual(['六=六', '百=百', '円=円']);
    // A number's odd reading never takes its counter's: 九 く + 時 じ, 四 よ + 人 にん.
    expect(content('{朝|あさ}{九時|くじ}の{電車|でんしゃ}').map((t) => t.reading)).toEqual(['あさ', 'く', 'じ', 'でんしゃ']);
    expect(words('{九時|くじ}ごろ')).toEqual(['九=九', '時=時', 'ごろ=ごろ']);
    expect(words('{四人|よにん}で{食|た}べた')).toEqual(['四=四', '人=人', '食べ=食べる']);
    expect(tk.core.get(content('{四人|よにん}')[1].ref!.slice(5))!.kana).toBe('にん');
  });

  it('shares a reading by the tokens’ possible readings, then by length', () => {
    expect(shareReading([['ろく'], ['ひゃく']], 'ろっぴゃく')).toEqual(['ろっ', 'ぴゃく']);
    expect(shareReading([['きゅう'], ['じ']], 'くじ')).toEqual(['く', 'じ']);
    expect(shareReading([['よん', 'し'], ['じん', 'にん']], 'よにん')).toEqual(['よ', 'にん']);
    expect(shareReading([['じゅう'], ['いち'], ['じ']], 'じゅういちじ')).toEqual(['じゅう', 'いち', 'じ']);
    // Nothing fits: shared out by length, at least one kana each.
    expect(shareReading([['abc'], ['d']], 'xy')).toEqual(['x', 'y']);
  });

  it('reads all-kana beginner text', () => {
    expect(words('まいあさパンをたべます。')).toEqual(['まいあさ=毎朝', 'パン=パン', 'たべ=食べる']);
    expect(words('ごしゅじんはせんせいです。')).toEqual(['ごしゅじん=ご主人', 'せんせい=先生']);
    expect(words('おっとはいしゃです。')).toEqual(['おっと=夫', 'いしゃ=医者']);
    expect(words('きょうはにちようびですよ。')).toEqual(['きょう=今日', 'にちようび=日曜日']);
    expect(words('テーブルにほんがあります。')).toEqual(['テーブル=テーブル', 'ほん=本', 'あり=ある']);
    expect(words('ごごさんじごふんです。')).toEqual(['ごご=午後', 'さん=三', 'じ=時', 'ご=五', 'ふん=分']);
    expect(words('せん えん おかえし です。')).toContain('せん=千');
    expect(words('しちじにおきました。')).toEqual(['しち=七', 'じ=時', 'おき=起きる']);
  });

  it('maps potential forms, aliases and masu-stem nouns to the words a learner knows', () => {
    expect(words('{眠|ねむ}れない')).toEqual(['眠れ=眠る']);
    expect(words('{時間|じかん}がない。')).toEqual(['時間=時間', 'ない=ある']);
    expect(words('{行|い}ってきます')).toEqual(['行ってきます=行ってきます']);
    // かもしれない is grammar: しれ is not the verb 知る.
    expect(content('{雨|あめ}かもしれません').map((t) => t.surface)).toEqual(['雨']);
  });

  it('marks names that are not core words as proper', () => {
    const tanaka = tokens('{田中|たなか}さんはいますか。').find((t) => t.surface === '田中')!;
    expect(tanaka.proper).toBe(true);
    expect(tokens('ゆいさんへ').find((t) => t.surface === 'ゆい')?.proper).toBe(true);
  });

  it.runIf(hasWords)('falls back to JMdict for words outside the core list', () => {
    const [shop] = content('{店内|てんない}でお{召|め}し{上|あ}がりですか。');
    expect(shop.surface).toBe('店内');
    expect(shop.ref).toMatch(/^word:\d+$/u);
  });

  it('gives core words their teaching order', () => {
    const [eat] = content('{食|た}べる');
    const taberu = [...tk.core.values()].find((w) => w.written === '食べる' && w.kana === 'たべる')!;
    expect(eat.ref).toBe(`core:${taberu.id}`);
    expect(coreOrder(eat)).toBe(taberu.order);
  });

  it('reads kanji without ruby (plain text) with kuromoji\'s readings', () => {
    expect(tokens('今何時ですか。').map((t) => t.reading).join('')).toBe('いまなんじですか。');
    expect(tokens('{今|いま}{何時|なんじ}ですか。').map((t) => t.reading).join('')).toBe('いまなんじですか。');
  });
});

describe('coverage', () => {
  it('counts content tokens against the ceiling and lists the rest', () => {
    const toks = tokens('{財布|さいふ}を{忘|わす}れました。{田中|たなか}さんに{電話|でんわ}します。');
    const all = coverageOf(toks, tk, 1560);
    expect(all.names).toEqual(['田中']);
    expect(all.ratio).toBe(1);
    const early = coverageOf(toks, tk, 300);
    expect(early.content).toBe(all.content);
    expect(early.covered).toBeLessThan(early.content);
    expect(early.uncovered.map((u) => u.lemma)).toContain('財布');
    expect(early.uncovered.every((u) => /^#\d+$/u.test(u.why))).toBe(true);
    expect(early.maxOrder).toBeGreaterThan(300);
  });

  it('detects the content kinds and builds items', () => {
    const story = {
      id: 'st-l0-99',
      level: 'L0',
      unit: 1,
      grammar: [],
      sentences: [{ jp: 'きのう／ラーメンを／{食|た}べました。', en: 'I ate ramen yesterday.' }],
      gist: { q: 'What?', options: ['a', 'b', 'c'], answer: 0 },
    };
    expect(detectKind(story)).toBe('story');
    expect(detectKind([{ id: 'x', jp: 'はい' }])).toBe('jp-list');
    expect(detectKind([{ id: 'rp', lines: [] }])).toBe('roleplay');
    expect(detectKind({ id: 3, grammar: [], coreWordCeiling: 300, canDos: [] })).toBe('unit');
    expect(detectKind([{ id: 'core' }])).toBeUndefined();
    const [item] = itemsOf('story', story);
    expect(item.texts.map((t) => t.jp)).toEqual([story.sentences[0].jp]);
    expect(plainText(story.sentences[0].jp)).toBe('きのうラーメンを食べました。');
  });
});
