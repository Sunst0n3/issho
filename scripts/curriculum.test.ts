// @vitest-environment node
// Curriculum v2 (scripts/lib/curriculum.ts) on small fixtures, then the design's checks on the
// built public/data (skipped until `npm run build:data` has produced a version 2 curriculum).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJMdict } from './lib/jmdict.ts';
import { selectWord } from './lib/words.ts';
import type { CoreWord, Curriculum, KanjiEntry, WordEntry, WordRef } from '../src/lib/types.ts';
import {
  BOOST,
  CONFUSABLE_GAP,
  buildCurriculum,
  commonReading,
  compareSpine,
  effectiveRank,
  kanjiBoosts,
  kanjiReadingIn,
  pickUnitWords,
  rareKanji,
  readingsOf,
  type CurriculumKanji,
  type UnitCandidate,
} from './lib/curriculum.ts';

let nextId = 1000;
function word(written: string, kana: string, pri: string[], extra: Partial<UnitCandidate> = {}): UnitCandidate {
  const id = String(nextId++);
  const kanji = [...new Set([...written].filter((ch) => /\p{Script=Han}/u.test(ch)))];
  const nf = pri.find((p) => /^nf\d\d$/.test(p));
  return {
    ref: extra.core ? `core:cw-${id}` : `word:${id}`,
    id,
    written,
    kana,
    kanji,
    pos: ['n'],
    meanings: ['x'],
    pri,
    freqRank: nf ? Number(nf.slice(2)) : 49,
    ...extra,
  };
}

describe('spine', () => {
  it('boosts the kanji of core words by order and of target words by 150', () => {
    const boosts = kanjiBoosts(
      [
        { written: '休む', order: 5 },
        { written: '林', order: 600 },
        { written: '森林', order: 1200 },
        { order: 7 },
      ],
      ['寺'],
    );
    expect(Object.fromEntries(boosts)).toEqual({ 休: BOOST.early, 林: BOOST.mid, 森: BOOST.late, 寺: BOOST.early });
  });

  it('orders by frequency rank minus boost, then frequency rank, then codepoint; a boost moves a kanji up by ≤ 150', () => {
    const kanji: CurriculumKanji[] = [
      { char: '休', freq: 642, strokeCount: 6 },
      { char: '体', freq: 88, strokeCount: 7 },
      { char: '林', freq: 1000, strokeCount: 8 },
      { char: '森', strokeCount: 12 },
      { char: '本', freq: 600, strokeCount: 5 },
    ];
    const boosts = new Map([['休', 150], ['森', 50]]);
    expect([...kanji].sort(compareSpine(boosts)).map((k) => k.char)).toEqual(['体', '休', '本', '林', '森']);
    for (const k of kanji) expect((k.freq ?? 2501) - effectiveRank(k, boosts)).toBeLessThanOrEqual(150);
  });

  it('calls a kanji rare when its frequency rank is over 1000 or it has no useful word', () => {
    const kanji: CurriculumKanji[] = [
      { char: '斤', freq: 2200, strokeCount: 4 },
      { char: '新', freq: 51, strokeCount: 13 },
      { char: '吏', freq: 900, strokeCount: 6 },
    ];
    const words = [word('新しい', 'あたらしい', ['ichi1']), word('官吏', 'かんり', ['news2', 'nf40'])];
    expect([...rareKanji(kanji, words)].sort()).toEqual(['吏', '斤']);
  });
});

describe('buildCurriculum', () => {
  const kanji: CurriculumKanji[] = [
    { char: '日', freq: 1, strokeCount: 4, on: ['ニチ'], kun: ['ひ'] },
    { char: '木', freq: 300, strokeCount: 4, kun: ['き'] },
    { char: '新', freq: 50, strokeCount: 13, on: ['シン'], kun: ['あたら.しい'] },
    { char: '立', freq: 60, strokeCount: 5, kun: ['た.つ'] },
    { char: '斤', freq: 2200, strokeCount: 4 },
    { char: '休', freq: 700, strokeCount: 6, kun: ['やす.む'] },
    { char: '本', freq: 10, strokeCount: 5, on: ['ホン'] },
    { char: '未', freq: 400, strokeCount: 5 },
    { char: '末', freq: 410, strokeCount: 5 },
  ];
  const components = new Map<string, string[]>([
    ['新', ['立', '木', '斤']],
    ['休', ['亻', '木']],
    ['本', ['木']],
    ['未', ['木']],
    ['末', ['木']],
  ]);
  const words = [
    word('日', 'ひ', ['ichi1', 'news1', 'nf03']),
    word('日', 'にち', ['spec1'], { core: true, coreOrder: 400 }),
    word('毎日', 'まいにち', ['ichi1']),
    word('本', 'ほん', ['ichi1'], { core: true, coreOrder: 50 }),
    word('日本', 'にほん', ['ichi1', 'news1', 'nf01'], { core: true, coreOrder: 20 }),
    word('本山', 'ほんざん', ['news1', 'nf20']),
    word('新しい', 'あたらしい', ['ichi1', 'news1', 'nf02'], { core: true, coreOrder: 90 }),
    word('新木', 'あらき', ['news2', 'nf40']),
    word('休む', 'やすむ', ['ichi1'], { core: true, coreOrder: 70 }),
    word('木', 'き', ['ichi1']),
    word('立つ', 'たつ', ['ichi1']),
    word('未定', 'みてい', ['news1', 'nf10']),
  ];
  const built = buildCurriculum({
    kanji,
    components,
    words,
    boosts: new Map([['休', 150]]),
    phonetic: new Set(['新']),
    confusables: [{ id: 'v-未末', chars: ['未', '末'], kind: 'visual' }],
  });
  const { units } = built.curriculum;
  const unit = (ch: string) => units.find((u) => u.char === ch)!;
  const shown = (ref: WordRef | null) => words.find((w) => w.ref === ref)?.written ?? null;

  it('teaches every kanji once, components first, rare components left in place as named parts', () => {
    expect(built.curriculum.version).toBe(2);
    // 末 waits 10 places after 未; with nothing else left it comes last.
    expect(units.map((u) => u.char).join('')).toBe('日木本立新未休斤末');
    expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
    expect(built.components.get('新')).toEqual(['立', '木']);
    expect(built.parts.get('新')).toEqual(['斤']);
    expect(built.parts.get('休')).toEqual(['亻']);
    expect(built.rare.has('斤')).toBe(true);
  });

  it('keeps visual confusables at least 10 positions apart', () => {
    const many: CurriculumKanji[] = Array.from({ length: 14 }, (_, i) => ({ char: String.fromCodePoint(0x4e00 + i * 3), freq: 100 + i, strokeCount: 3 }));
    const [a, b] = [many[1].char, many[2].char];
    const spaced = buildCurriculum({ kanji: many, components: new Map(), words: [], confusables: [{ id: 'v', chars: [a, b], kind: 'visual' }] });
    const at = new Map(spaced.curriculum.units.map((u) => [u.char, u.index]));
    expect(at.get(b)! - at.get(a)!).toBe(CONFUSABLE_GAP);
    expect(spaced.spaced).toEqual([b]);
    const meaning = buildCurriculum({ kanji: many, components: new Map(), words: [], confusables: [{ id: 'm', chars: [a, b], kind: 'meaning' }] });
    expect(meaning.curriculum.units.map((u) => u.char)).toEqual(many.map((k) => k.char));
    expect(meaning.curriculum.confusables).toEqual([{ id: 'm', chars: [a, b], kind: 'meaning' }]);
  });

  it('gives each kanji an anchor and up to two staged words whose kanji are taught', () => {
    expect(shown(unit('日').anchor)).toBe('日');
    expect(unit('日').anchor).toBe(words[1].ref); // にち: core and the common reading
    expect(shown(unit('本').anchor)).toBe('日本');
    expect(unit('本').staged.map(shown)).toEqual(['本']);
    expect(shown(unit('新').anchor)).toBe('新しい');
    expect(shown(unit('立').anchor)).toBe('立つ');
    expect(unit('斤').anchor).toBeNull();
    for (const u of units) {
      expect(u.staged.length).toBeLessThanOrEqual(2);
      for (const ref of [u.anchor, ...u.staged].filter((r): r is WordRef => !!r)) {
        const w = words.find((x) => x.ref === ref)!;
        for (const ch of w.kanji) expect(unit(ch).index).toBeLessThanOrEqual(u.index);
      }
    }
    const refs = units.flatMap((u) => [u.anchor, ...u.staged]).filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('drops words whose only priority is the news (本山, 新木, 未定)', () => {
    const all = units.flatMap((u) => [u.anchor, ...u.staged]).map(shown);
    for (const w of ['本山', '新木', '未定']) expect(all).not.toContain(w);
  });

  it('marks inferable kanji: two or more known parts and no phonetic component', () => {
    expect(unit('休').inferable).toBe(true);
    expect(unit('新').inferable).toBe(false);
    expect(unit('本').inferable).toBe(false);
  });

  it('counts a repeated component each time for inferable (林 is 木 + 木)', () => {
    const forest: CurriculumKanji[] = [
      { char: '木', freq: 1, strokeCount: 4 },
      { char: '林', freq: 2, strokeCount: 8 },
    ];
    const input = { kanji: forest, components: new Map([['林', ['木']]]), words: [] };
    const inferable = (counts?: Map<string, number>) =>
      buildCurriculum({ ...input, componentCounts: counts }).curriculum.units.find((u) => u.char === '林')!.inferable;
    expect(inferable(new Map([['林', 2]]))).toBe(true);
    expect(inferable(new Map([['林', 2]]).set('木', 0))).toBe(true);
    expect(inferable()).toBe(false);
    expect(buildCurriculum({ ...input, componentCounts: new Map([['林', 2]]), phonetic: new Set(['林']) }).curriculum.units[1].inferable).toBe(false);
  });

  it('numbers chapters of 15 kanji', () => {
    const many: CurriculumKanji[] = Array.from({ length: 31 }, (_, i) => ({ char: String.fromCodePoint(0x4e00 + i), freq: i + 1, strokeCount: 3 }));
    const { units: list } = buildCurriculum({ kanji: many, components: new Map(), words: [] }).curriculum;
    expect(list.map((u) => u.chapter)).toEqual([...Array(15).fill(1), ...Array(15).fill(2), 3]);
  });

  it('teaches listed override words first and warns about unusable ones', () => {
    const warnings: string[] = [];
    const ho = words[3];
    const { curriculum } = buildCurriculum({
      kanji,
      components,
      words,
      overrides: { 本: [[ho.id, '本', 'ほん'], ['999999', '本屋', 'ほんや']] },
      warn: (m) => warnings.push(m),
    });
    const u = curriculum.units.find((x) => x.char === '本')!;
    expect(u.anchor).toBe(ho.ref);
    expect(u.staged.map(shown)).toEqual(['日本']);
    expect(warnings).toEqual([
      'word override for 本: 本屋 ほんや (999999) is not a candidate (not in words.json, or a core word usually written in kana); using the automatic pick',
    ]);
  });
});

describe('pickUnitWords', () => {
  it('scores useful, core, common-reading and short words, and penalises news-only ones', () => {
    const readings = readingsOf({ on: ['ジン', 'ニン'], kun: ['ひと'] });
    const picked = pickUnitWords(
      '人',
      [
        word('人々', 'ひとびと', ['ichi1', 'news1', 'nf01']),
        word('人', 'ひと', ['ichi1'], { core: true, coreOrder: 30 }),
        word('一人', 'ひとり', ['ichi1', 'nf02'], { core: true, coreOrder: 60 }),
        word('人', 'じん', ['ichi1'], { pos: ['suf'], meanings: ['-ian'] }),
        word('人工', 'じんこう', ['news1', 'nf05']),
      ],
      readings,
    );
    // 人 ひと 9 (useful, core, common reading ひと, short), 一人 7, 人々 6, 人 じん 4; 人工 is news-only.
    expect(picked.map((w) => `${w.written} ${w.kana}`)).toEqual(['人 ひと', '一人 ひとり', '人々 ひとびと']);
  });

  it('breaks ties by core order, and never opens with a bare suffix while another word exists', () => {
    const tie = pickUnitWords('人', [
      word('一人', 'ひとり', ['ichi1', 'nf02'], { core: true, coreOrder: 60 }),
      word('人', 'ひと', ['ichi1'], { core: true, coreOrder: 30 }),
    ]);
    expect(tie.map((w) => w.written)).toEqual(['人', '一人']);
    const suffix = pickUnitWords('的', [
      word('的', 'てき', ['ichi1', 'spec1'], { pos: ['suf', 'adj-na'], meanings: ['-ical'] }),
      word('目的', 'もくてき', ['news1', 'nf01', 'ichi1']),
    ]);
    expect(suffix.map((w) => w.written)).toEqual(['目的', '的']);
  });

  it('keeps a news-only word when it is a core word, and skips a spelling already picked', () => {
    const picked = pickUnitWords('土', [
      word('土', 'つち', ['ichi1']),
      word('土', 'ど', ['spec1']),
      word('土木', 'どぼく', ['news1', 'nf07'], { core: true, coreOrder: 900 }),
    ]);
    expect(picked.map((w) => `${w.written} ${w.kana}`)).toEqual(['土 つち', '土木 どぼく']);
  });

  it('finds the reading a kanji has inside a word, with rendaku and gemination', () => {
    const readings = readingsOf({ on: ['ニチ', 'ジツ'], kun: ['ひ', '-び', '-か'] });
    expect(readings).toEqual(['にち', 'じつ', 'ひ', 'び', 'か']);
    expect(kanjiReadingIn('日', { written: '毎日', kana: 'まいにち' }, readings)).toBe('にち');
    expect(kanjiReadingIn('日', { written: '休日', kana: 'きゅうじつ' }, readings)).toBe('じつ');
    expect(kanjiReadingIn('日', { written: '日', kana: 'ひ' }, readings)).toBe('ひ');
    expect(kanjiReadingIn('日', { written: '日帰り', kana: 'ひがえり' }, readings)).toBe('ひ');
    expect(kanjiReadingIn('一', { written: '一回', kana: 'いっかい' }, ['いち', 'ひと'])).toBe('いち');
    const all = [word('毎日', 'まいにち', []), word('日曜', 'にちよう', []), word('日', 'ひ', [])];
    expect(commonReading('日', all, readings)).toBe('にち');
  });
});

// ---------------------------------------------------------------------------------------------
// The built curriculum

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));
const JMDICT = fileURLToPath(new URL('../data-raw/JMdict_e.gz', import.meta.url));
const read = <T,>(file: string): T => JSON.parse(readFileSync(DATA + file, 'utf8')) as T;
const built = existsSync(`${DATA}curriculum.json`) && read<{ version?: number }>('curriculum.json').version === 2;

describe.skipIf(!built)('public/data/curriculum.json', () => {
  const curriculum = built ? read<Curriculum>('curriculum.json') : ({ units: [], confusables: [] } as unknown as Curriculum);
  const kanji = built ? read<Record<string, KanjiEntry>>('kanji.json') : {};
  const words = built ? read<WordEntry[]>('words.json') : [];
  const core = built ? read<CoreWord[]>('content/core-words.json') : [];
  const index = new Map(curriculum.units.map((u) => [u.char, u.index]));
  const coreById = new Map(core.map((c) => [c.id, c]));
  const wordById = new Map(words.map((w) => [w.id, w]));
  const written = (ref: WordRef) => (ref.startsWith('core:') ? coreById.get(ref.slice(5))?.written : wordById.get(ref.slice(5))?.written);

  it('leaves the rare components 乙 弔 丙 吏 斤 丈 巾 旦 out of the first 300', () => {
    for (const ch of '乙弔丙吏斤丈巾旦') expect(index.get(ch)!, ch).toBeGreaterThanOrEqual(300);
  });

  it('teaches every component before its first use', () => {
    for (const u of curriculum.units) {
      for (const c of kanji[u.char].components) expect(index.get(c)!, `${c} in ${u.char}`).toBeLessThan(u.index);
    }
  });

  it('publishes about 60 confusable sets, with the numbers and weekdays as meaning sets (at most 3 numbers a day)', () => {
    expect(curriculum.confusables.length).toBeGreaterThanOrEqual(50);
    expect(curriculum.confusables.length).toBeLessThanOrEqual(80);
    const set = (id: string) => curriculum.confusables.find((s) => s.id === id);
    expect(set('m-numbers')).toEqual({ id: 'm-numbers', chars: [...'一二三四五六七八九十'], kind: 'meaning' });
    expect(set('m-weekdays')).toEqual({ id: 'm-weekdays', chars: [...'日月火水木金土'], kind: 'meaning' });
  });

  it('keeps the members of each visual confusable set ≥ 10 positions apart', () => {
    for (const set of curriculum.confusables.filter((s) => s.kind === 'visual')) {
      const at = set.chars.map((ch) => index.get(ch)!).sort((a, b) => a - b);
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1], set.id).toBeGreaterThanOrEqual(CONFUSABLE_GAP);
    }
  });

  it('opens none of the first 150 kanji with a newspaper word (国会, 年金, 中立, 土木, 会長, 本山)', () => {
    const anchors = curriculum.units.slice(0, 150).map((u) => (u.anchor ? written(u.anchor) : undefined));
    for (const w of ['国会', '年金', '中立', '土木', '会長', '本山']) expect(anchors).not.toContain(w);
  });

  it('gives every kanji an anchor with ichi1/spec or a core word wherever such a candidate exists', async () => {
    const useful = (w: WordEntry) => !!w.core || (w.pri ?? []).some((p) => /^(ichi1|spec[12])$/.test(p));
    const used = new Set<string>();
    const ref = (w: WordEntry): string => (w.core ? `core:${w.core}` : `word:${w.id}`);
    const byKanji = new Map<string, WordEntry[]>();
    for (const w of words) for (const ch of w.kanji) byKanji.set(ch, [...(byKanji.get(ch) ?? []), w]);
    const problems: string[] = [];
    for (const u of curriculum.units) {
      const anchor = u.anchor;
      const anchorUseful = anchor
        ? anchor.startsWith('core:') || useful(wordById.get(anchor.slice(5))!)
        : false;
      if (!anchorUseful) {
        const better = (byKanji.get(u.char) ?? []).find(
          (w) => useful(w) && !used.has(ref(w)) && w.kanji.every((c) => (index.get(c) ?? Infinity) <= u.index) &&
            !(w.core && !coreById.get(w.core)?.written),
        );
        if (better) problems.push(better.id);
      }
      for (const r of [u.anchor, ...u.staged]) if (r) used.add(r);
    }
    // The only excuse: JMdict marks the better-looking word derogatory, sensitive or slang (売国奴).
    const offensive = new Set<string>();
    const ids = new Set(problems);
    if (ids.size > 0 && existsSync(JMDICT)) {
      await readJMdict(JMDICT, (e) => {
        if (ids.has(e.id) && selectWord(e, () => true)?.offensive) offensive.add(e.id);
      });
    }
    expect(problems.filter((id) => !offensive.has(id)).map((id) => wordById.get(id)!.written)).toEqual([]);
  }, 60_000);

  it('offers the pre-guess for kanji built from known parts, repeated ones included (休, 明, 林), never for phonetic ones', () => {
    const inferable = (ch: string) => curriculum.units[index.get(ch)!].inferable;
    for (const ch of '休明林森炎') expect(inferable(ch), ch).toBe(true);
    for (const ch of '語時晴') expect(inferable(ch), ch).toBe(false);
  });

  it('gives kanji.json the curriculum rank and parts of every kanji', () => {
    expect(Object.keys(kanji)).toEqual(curriculum.units.map((u) => u.char));
    for (const u of curriculum.units) expect(kanji[u.char].rank, u.char).toBe(u.index + 1);
    expect(kanji['新'].parts).toContain('斤');
  });
});
