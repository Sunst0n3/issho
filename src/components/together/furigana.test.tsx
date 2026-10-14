import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WordEntry } from '../../lib/types.ts';
import { alignReading, buildFuriganaDict, segmentFurigana, type FuriganaSegment } from './furigana.ts';
import { FuriganaText } from './FuriganaText.tsx';

afterEach(cleanup);

const word = (id: string, written: string, kana: string, pos: string[] = ['n'], freqRank = 10): WordEntry => ({
  id, written, kana, pos, freqRank, meanings: [], kanji: [...written].filter((c) => /\p{Script=Han}/u.test(c)),
});

const WORDS: WordEntry[] = [
  word('1', '私', 'わたし', ['pn']),
  word('2', '水', 'みず'),
  word('3', '水曜日', 'すいようび'),
  word('4', '曜日', 'ようび'),
  word('5', '食べる', 'たべる', ['v1', 'vt']),
  word('6', '飲む', 'のむ', ['v5m', 'vt']),
  word('7', '日', 'ひ', ['n'], 5),
  word('8', '日', 'にち', ['n'], 8),
  word('9', '取り消す', 'とりけす', ['v5s', 'vt']),
  word('10', '行く', 'いく', ['v5k-s', 'vi']),
  word('11', '高い', 'たかい', ['adj-i']),
  word('12', 'お茶', 'おちゃ'),
  word('13', '今日', 'きょう', ['n'], 2),
  word('14', '今日', 'こんにち', ['n'], 30),
  word('15', 'ガス代', 'ガスだい'),
];

const dict = () => buildFuriganaDict(WORDS);

/** "{base|reading}" for annotated runs, plain text otherwise: easy to compare. */
const show = (segs: FuriganaSegment[]) => segs.map((s) => (s.reading ? `{${s.text}|${s.reading}}` : s.text)).join('');

describe('alignReading', () => {
  it('puts the reading over the kanji and leaves okurigana bare', () => {
    expect(alignReading('食べる', 'たべる')).toEqual([{ text: '食', reading: 'た' }, { text: 'べる' }]);
  });

  it('splits readings across several kanji runs', () => {
    expect(show(alignReading('取り消す', 'とりけす'))).toBe('{取|と}り{消|け}す');
    expect(show(alignReading('お茶', 'おちゃ'))).toBe('お{茶|ちゃ}');
  });

  it('gives an all-kanji word one reading', () => {
    expect(alignReading('水曜日', 'すいようび')).toEqual([{ text: '水曜日', reading: 'すいようび' }]);
  });

  it('matches katakana in the spelling against the reading', () => {
    expect(show(alignReading('ガス代', 'ガスだい'))).toBe('ガス{代|だい}');
  });

  it('falls back to the whole word when the kana do not line up', () => {
    expect(alignReading('食べる', 'くう')).toEqual([{ text: '食べる', reading: 'くう' }]);
  });
});

describe('segmentFurigana', () => {
  it('annotates a sentence by longest match', () => {
    expect(show(segmentFurigana('私は水曜日に水を飲みました。', dict())))
      .toBe('{私|わたし}は{水曜日|すいようび}に{水|みず}を{飲|の}みました。');
  });

  it('matches inflected verbs and adjectives by their stems', () => {
    const d = dict();
    expect(show(segmentFurigana('食べました', d))).toBe('{食|た}べました');
    expect(show(segmentFurigana('行って', d))).toBe('{行|い}って');
    expect(show(segmentFurigana('取り消して', d))).toBe('{取|と}り{消|け}して');
    expect(show(segmentFurigana('高かった', d))).toBe('{高|たか}かった');
  });

  it('prefers the most common reading of a longer word', () => {
    expect(show(segmentFurigana('今日は', dict()))).toBe('{今日|きょう}は');
  });

  // Ranks as in the real words.json: 行く has no newspaper rank (49), 行う ranks 1, and the
  // prefix 来 (らい, "next") is a word of its own.
  const chatDict = () => buildFuriganaDict([
    word('a', '行く', 'いく', ['v5k-s', 'vi'], 49),
    word('b', '行う', 'おこなう', ['v5u', 'vt'], 1),
    word('c', '来る', 'くる', ['vk', 'vi'], 16),
    word('d', '来', 'らい', ['pref'], 5),
    word('e', '来週', 'らいしゅう', ['n'], 3),
    word('f', '持って来る', 'もってくる', ['vk', 'vt'], 30),
    word('g', '開く', 'ひらく', ['v5k', 'vi', 'vt'], 49),
    word('h', '開く', 'あく', ['v5k', 'vi'], 49),
    word('i', '市場', 'いちば', ['n'], 1),
    word('j', '市場', 'しじょう', ['n'], 1),
    word('k', '場', 'ば', ['n'], 4),
  ]);

  it('reads 行った as いった, not the newspaper verb おこなった', () => {
    const d = chatDict();
    expect(show(segmentFurigana('会社に行った', d))).toBe('会社に{行|い}った');
    expect(show(segmentFurigana('行ってきます', d))).toBe('{行|い}ってきます');
  });

  it('reads the changing vowel of 来る', () => {
    const d = chatDict();
    expect(show(segmentFurigana('先生が来た', d))).toBe('先生が{来|き}た');
    expect(show(segmentFurigana('来ます', d))).toBe('{来|き}ます');
    expect(show(segmentFurigana('来ない？', d))).toBe('{来|こ}ない？');
    expect(show(segmentFurigana('早く来い', d))).toBe('早く{来|こ}い');
    expect(show(segmentFurigana('来週また来る', d))).toBe('{来週|らいしゅう}また{来|く}る');
    expect(show(segmentFurigana('持って来て', d))).toBe('{持|も}って{来|き}て');
    // Any other 来 could be either the verb or the prefix らい.
    expect(show(segmentFurigana('来れる', d))).toBe('来れる');
  });

  it('leaves words with two equally likely readings bare, including the kanji inside them', () => {
    const d = chatDict();
    expect(show(segmentFurigana('店が開いてる', d))).toBe('店が開いてる');
    expect(show(segmentFurigana('市場に行こう', d))).toBe('市場に{行|い}こう');
  });

  it('leaves a lone kanji with several readings, and unknown kanji, bare', () => {
    const d = dict();
    expect(segmentFurigana('日', d)).toEqual([{ text: '日' }]);
    expect(segmentFurigana('猫がいる', d)).toEqual([{ text: '猫がいる' }]);
  });

  it('keeps text without kanji as one plain run', () => {
    expect(segmentFurigana('おはよう！', dict())).toEqual([{ text: 'おはよう！' }]);
  });

  it('memoizes results per text', () => {
    const d = dict();
    expect(segmentFurigana('水を飲む', d)).toBe(segmentFurigana('水を飲む', d));
  });
});

describe('FuriganaText', () => {
  it('shows readings only where the predicate allows', () => {
    const known = new Set(['水']);
    const { container } = render(
      <FuriganaText text="私は水を飲む" dict={dict()} show={(base) => [...base].some((c) => !known.has(c))} />,
    );
    const readings = [...container.querySelectorAll('rt')].map((rt) => rt.textContent);
    expect(readings).toEqual(['わたし', 'の']);
    expect(container.textContent).toContain('水');
  });

  it('renders plain text without a dictionary', () => {
    const { container } = render(<FuriganaText text="水" show="all" />);
    expect(container.querySelector('rt')).toBeNull();
    expect(container.textContent).toBe('水');
  });
});
