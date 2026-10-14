import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db, updateSettings } from '../../../lib/db.ts';
import type { CardRecord } from '../../../lib/types.ts';
import { seededRandom } from '../../../srs/answers.ts';
import { introduceItem } from '../../../srs/items.ts';
import { grammarGloss, kanaToRomaji, longVowelsSpelledOut, shortInterval, untilText } from '../format.ts';
import { KANA, KANJI, resetStudyDb, SURVIVAL, WORDS } from '../test-utils.tsx';
import { prepareCard, writePromptReading } from './prepare.ts';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);

async function cardOf(kind: CardRecord['kind'], key: string, type: CardRecord['type']): Promise<CardRecord> {
  await introduceItem(kind, key);
  return (await db.cards.get(cardId(`${kind}:${key}`, type)))!;
}

beforeEach(async () => {
  await resetStudyDb();
});

describe('prepareCard', () => {
  it('kana read: four distinct romaji of the same script, including the answer', async () => {
    const prepared = await prepareCard(await cardOf('kana', 'あ', 'read'), seededRandom(1));
    expect(prepared?.view).toBe('kana-read');
    if (prepared?.view !== 'kana-read') return;
    expect(prepared.options).toHaveLength(4);
    expect(new Set(prepared.options).size).toBe(4);
    expect(prepared.options).toContain('a');
    // Yōon and katakana never show up for a basic hiragana.
    expect(prepared.options).not.toContain('kya');
  });

  it('kana read: を is never offered "o" (from お), which is also right for it', async () => {
    const wo = { char: 'を', script: 'hiragana' as const, romaji: 'wo', group: 'wa', kind: 'basic' as const, order: 44, altRomaji: ['o'] };
    KANA.push(wo);
    try {
      for (let seed = 0; seed < 40; seed++) {
        const prepared = await prepareCard(await cardOf('kana', 'を', 'read'), seededRandom(seed));
        if (prepared?.view !== 'kana-read') throw new Error('wrong view');
        expect(prepared.options).toContain('wo');
        expect(prepared.options).not.toContain('o');
        expect(prepared.options).toHaveLength(4);
      }
    } finally {
      KANA.splice(KANA.indexOf(wo), 1);
    }
  });

  it('kana read: は and へ are never offered "wa" and "e", their sounds as particles', async () => {
    const extra = [['は', 'ha'], ['へ', 'he'], ['わ', 'wa'], ['ひ', 'hi']].map(([char, romaji], i) =>
      ({ char, script: 'hiragana' as const, romaji, group: romaji, kind: 'basic' as const, order: 60 + i }));
    KANA.push(...extra);
    try {
      for (let seed = 0; seed < 30; seed++) {
        const ha = await prepareCard(await cardOf('kana', 'は', 'read'), seededRandom(seed));
        if (ha?.view !== 'kana-read') throw new Error('wrong view');
        expect(ha.options).toContain('ha');
        expect(ha.options).not.toContain('wa');
        const he = await prepareCard(await cardOf('kana', 'へ', 'read'), seededRandom(seed));
        if (he?.view !== 'kana-read') throw new Error('wrong view');
        expect(he.options).not.toContain('e');
      }
    } finally {
      KANA.splice(KANA.length - extra.length);
    }
  });

  it('vocab recall: the wrong options use only kana the learner can read', async () => {
    for (const k of ['あ', 'い', 'う', 'え']) await introduceItem('kana', k);
    for (let seed = 0; seed < 20; seed++) {
      const prepared = await prepareCard(await cardOf('vocab', 'sw-ie', 'recall'), seededRandom(seed));
      if (prepared?.view !== 'vocab-recall') throw new Error('wrong view');
      expect(prepared.options).toContain('いえ');
      // かお has か and お, not learned yet; いいえ, あい and うえ use known kana only.
      expect(prepared.options).not.toContain('かお');
      expect([...prepared.options].sort()).toEqual(['あい', 'いいえ', 'いえ', 'うえ'].sort());
    }
    // Knowing the whole script makes every word fair again.
    await updateSettings({ knowsHiragana: true });
    const options = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const prepared = await prepareCard(await cardOf('vocab', 'sw-ie', 'recall'), seededRandom(seed));
      if (prepared?.view === 'vocab-recall') prepared.options.forEach((o) => options.add(o));
    }
    expect(options.has('かお')).toBe(true);
    expect(SURVIVAL.some((w) => w.kana === 'かお')).toBe(true);
  });

  it('vocab recall: with too few readable survival words, readable common words come before unreadable ones', async () => {
    // A readable word that also means "no" would be a second right answer for いいえ.
    const nay = { id: 'w-nay', written: '否', kana: 'えい', meanings: ['no'], pos: ['int'], freqRank: 10, kanji: ['否'] };
    WORDS.push(nay);
    try {
      for (const k of ['い', 'え']) await introduceItem('kana', k);
      for (let seed = 0; seed < 20; seed++) {
        const prepared = await prepareCard(await cardOf('vocab', 'sw-iie', 'recall'), seededRandom(seed));
        if (prepared?.view !== 'vocab-recall') throw new Error('wrong view');
        expect(prepared.options).toContain('いいえ');
        expect(prepared.options).toContain('いえ');
        expect(prepared.options).toHaveLength(4);
        // あ, う, か and お aren't learned: those survival words only come once nothing readable is left.
        for (const unreadable of ['あい', 'うえ', 'かお']) expect(prepared.options).not.toContain(unreadable);
        expect(prepared.options).not.toContain('えい');
      }
    } finally {
      WORDS.splice(WORDS.indexOf(nay), 1);
    }
  });

  it('word meaning: English options come from words already taught, then words at the same level', async () => {
    const rare = { id: 'w-rare', written: '遠心力', kana: 'えんしんりょく', meanings: ['centrifugal force'], pos: ['n'], freqRank: 30, kanji: ['遠', '心', '力'] };
    WORDS.push(rare);
    try {
      await introduceItem('word', 'w-hi');
      for (let seed = 0; seed < 20; seed++) {
        const prepared = await prepareCard(await cardOf('word', 'w-mizu', 'meaning'), seededRandom(seed));
        if (prepared?.view !== 'word-meaning') throw new Error('wrong view');
        expect(prepared.options).toContain('water');
        expect(prepared.options).toContain('fire'); // taught
        expect(prepared.options).not.toContain('centrifugal force');
        expect(prepared.options).toHaveLength(4);
      }
    } finally {
      WORDS.pop();
    }
  });

  it("kanji reading: doesn't show a word whose own reading card is in the same block", async () => {
    await introduceItem('word', 'w-mizu');
    await introduceItem('word', 'w-sui');
    const block = [cardId('word:w-mizu', 'reading'), cardId('kanji:水', 'reading')];
    for (let seed = 0; seed < 10; seed++) {
      const prepared = await prepareCard(await cardOf('kanji', '水', 'reading'), seededRandom(seed), { block });
      if (prepared?.view !== 'kanji-reading') throw new Error('wrong view');
      expect(prepared.word?.id).toBe('w-sui');
    }
    // Every taught word asked already: one of the kanji's own readings the words don't use.
    const all = [...block, cardId('word:w-sui', 'reading')];
    const own = await prepareCard(await cardOf('kanji', '水', 'reading'), seededRandom(1), { block: all });
    if (own?.view !== 'kanji-reading') throw new Error('wrong view');
    expect(own.word).toBeUndefined();
    expect(own.answer).toBe('すい');
  });

  it('kana write: names the row when another kana has the same romaji', async () => {
    const dakuten = (char: string, romaji: string, group: string, order: number) =>
      ({ char, script: 'hiragana' as const, romaji, group, kind: 'dakuten' as const, order });
    const added = [dakuten('ざ', 'za', 'za', 50), dakuten('じ', 'ji', 'za', 51), dakuten('だ', 'da', 'da', 55), dakuten('ぢ', 'ji', 'da', 56)];
    KANA.push(...added);
    try {
      const di = await prepareCard(await cardOf('kana', 'ぢ', 'write'));
      if (di?.view !== 'kana-write') throw new Error('wrong view');
      expect(di.row).toBe('だ');
      const zi = await prepareCard(await cardOf('kana', 'じ', 'write'));
      if (zi?.view !== 'kana-write') throw new Error('wrong view');
      expect(zi.row).toBe('ざ');
      const a = await prepareCard(await cardOf('kana', 'あ', 'write'));
      if (a?.view !== 'kana-write') throw new Error('wrong view');
      expect(a.row).toBeUndefined();
    } finally {
      KANA.splice(KANA.length - added.length);
    }
  });

  it('kanji meaning: similar-level distractors that share no meaning with the answer', async () => {
    const prepared = await prepareCard(await cardOf('kanji', '日', 'meaning'), seededRandom(2));
    if (prepared?.view !== 'kanji-meaning') throw new Error('wrong view');
    expect(prepared.options).toContain('day');
    expect(prepared.options).not.toContain('sun');
    expect(prepared.notAccepted).not.toContain('day');
    expect(prepared.notAccepted).not.toContain('sun');
  });

  it("kanji meaning: a typed answer is guarded against every other kanji's meaning, not only the options shown", async () => {
    const prepared = await prepareCard(await cardOf('kanji', '日', 'meaning'), seededRandom(2));
    if (prepared?.view !== 'kanji-meaning') throw new Error('wrong view');
    const others = Object.values(KANJI).filter((k) => k.char !== '日').flatMap((k) => k.meanings);
    expect([...prepared.notAccepted].sort()).toEqual([...new Set(others)].sort());
  });

  it('kanji reading: shows a taught word and offers word readings', async () => {
    await introduceItem('word', 'w-sui');
    const prepared = await prepareCard(await cardOf('kanji', '水', 'reading'), seededRandom(3));
    if (prepared?.view !== 'kanji-reading') throw new Error('wrong view');
    expect(prepared.word?.written).toBe('水曜日');
    expect(prepared.answer).toBe('すいようび');
    expect(prepared.options).toContain('すいようび');
    expect(prepared.breakdown.map((b) => b.char)).toEqual(['水', '曜', '日']);
  });

  it('kanji reading without a taught word asks for one of its readings', async () => {
    const prepared = await prepareCard(await cardOf('kanji', '水', 'reading'), seededRandom(4));
    if (prepared?.view !== 'kanji-reading') throw new Error('wrong view');
    expect(prepared.word).toBeUndefined();
    expect(prepared.answer).toBe('みず');
    expect(prepared.options).not.toContain('すい');
  });

  it('grammar drill: the drill options, shuffled', async () => {
    const prepared = await prepareCard(await cardOf('grammar', 'wa-desu', 'drill'), seededRandom(5));
    if (prepared?.view !== 'grammar-drill') throw new Error('wrong view');
    expect([...prepared.options].sort()).toEqual([...prepared.drill.options].sort());
  });

  it('returns null when the item is not in the data', async () => {
    expect(await prepareCard(await cardOf('kanji', '龍', 'meaning'))).toBeNull();
  });
});

describe('helpers', () => {
  it('writePromptReading prefers a one-kanji word, then a kun reading', () => {
    const kanji = { char: '食', meanings: ['eat'], kun: ['た.べる'], on: ['ショク'], strokeCount: 9, components: [] };
    expect(writePromptReading(kanji, [])).toBe('たべる');
    expect(writePromptReading({ ...kanji, kun: [] }, [])).toBe('ショク');
  });

  it('kanaToRomaji handles yōon, small tsu and katakana', () => {
    const kana = [...KANA, { char: 'て', script: 'hiragana' as const, romaji: 'te', group: 'ta', kind: 'basic' as const, order: 99 }];
    expect(kanaToRomaji('みず', kana)).toBe('mizu');
    expect(kanaToRomaji('きゃあ', kana)).toBe('kyaa');
    expect(kanaToRomaji('いって', kana)).toBe('itte');
    expect(kanaToRomaji('ア.イ', kana)).toBe('ai');
  });

  it('kanaToRomaji keeps a final small tsu, and reads ヴ and loanword sounds', () => {
    const kana = [...KANA, { char: 'じ', script: 'hiragana' as const, romaji: 'ji', group: 'za', kind: 'dakuten' as const, order: 98 }];
    expect(kanaToRomaji('ジッ', kana)).toBe('jit');
    expect(kanaToRomaji('じっ', kana)).not.toBe(kanaToRomaji('じ', kana));
    expect(kanaToRomaji('ヴ', kana)).toBe('vu');
    expect(kanaToRomaji('ヴァイオリン', kana)).toMatch(/^va/);
  });

  it('kanaToRomaji reads は, へ and を as particles in words and phrases, not in readings', () => {
    const kana = [
      ...KANA,
      ...[['こ', 'ko'], ['ん', 'n'], ['に', 'ni'], ['ち', 'chi'], ['は', 'ha'], ['ば', 'ba'], ['ど', 'do'], ['と', 'to'], ['れ', 're'], ['を', 'wo'], ['へ', 'he']]
        .map(([char, romaji], i) => ({ char, script: 'hiragana' as const, romaji, group: romaji, kind: 'basic' as const, order: 100 + i })),
    ];
    expect(kanaToRomaji('こんにちは', kana, { particles: true })).toBe('konnichiwa');
    expect(kanaToRomaji('こんばんは', kana, { particles: true })).toBe('konbanwa');
    expect(kanaToRomaji('トイレは どこ', kana, { particles: true })).toBe('toire wa doko');
    expect(kanaToRomaji('みずを', kana, { particles: true })).toBe('mizuo');
    // は that starts a word, or a reading, stays "ha".
    expect(kanaToRomaji('はは', kana, { particles: true })).toBe('haha');
    expect(kanaToRomaji('こんにちは', kana)).toBe('konnichiha');
  });

  it('shortInterval moves up a unit once the rounded number reaches it', () => {
    const now = new Date(2026, 9, 14, 12);
    const later = (ms: number) => new Date(now.getTime() + ms);
    expect(shortInterval(later(10 * 60_000), now)).toBe('10m');
    expect(shortInterval(later(59.6 * 60_000), now)).toBe('1h');
    expect(shortInterval(later(6 * 3_600_000), now)).toBe('6h');
    expect(shortInterval(later(23.6 * 3_600_000), now)).toBe('1d');
    expect(shortInterval(later(24 * 3_600_000), now)).toBe('1d');
    expect(shortInterval(later(8 * 86_400_000), now)).toBe('8d');
  });

  it('grammarGloss drops a Japanese name the pattern already shows, keeps an English one', () => {
    expect(grammarGloss({ title: '〜は〜です — "X is Y"', pattern: '〜は〜です' })).toBe('"X is Y"');
    expect(grammarGloss({ title: '〜まえに・〜あとで — "before", "after"', pattern: '〜る{前|まえ}に・〜た{後|あと}で' })).toBe('"before", "after"');
    expect(grammarGloss({ title: 'あります・います — "there is", "I have"', pattern: '〜に〜があります・〜がいます' })).toBe('"there is", "I have"');
    expect(grammarGloss({ title: 'い-adjectives — "it\'s tasty"', pattern: '〜いです' })).toBe('い-adjectives — "it\'s tasty"');
  });

  it('longVowelsSpelledOut writes a long-vowel mark as the vowel it stretches', () => {
    expect(longVowelsSpelledOut('コーヒー')).toBe('こおひい');
    expect(longVowelsSpelledOut('ビーだま')).toBe('びいだま');
    expect(longVowelsSpelledOut('ウォールがい')).toBe('うぉおるがい');
    expect(longVowelsSpelledOut('すいようび')).toBe('すいようび');
  });

  it('untilText reads naturally', () => {
    const now = new Date(2026, 9, 14, 12);
    const later = (ms: number) => new Date(now.getTime() + ms);
    expect(untilText(later(10 * 60_000), now)).toBe('in 10 minutes');
    expect(untilText(later(26 * 3_600_000), now)).toBe('tomorrow');
    expect(untilText(later(4 * 86_400_000), now)).toBe('in 4 days');
    expect(untilText(later(90 * 86_400_000), now)).toBe('in 3 months');
  });
});
