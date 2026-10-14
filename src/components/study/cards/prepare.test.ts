import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import type { CardRecord } from '../../../lib/types.ts';
import { seededRandom } from '../../../srs/answers.ts';
import { introduceItem } from '../../../srs/items.ts';
import { kanaToRomaji, longVowelsSpelledOut, untilText } from '../format.ts';
import { KANA, resetStudyDb } from '../test-utils.tsx';
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
    expect(prepared.notAccepted).toHaveLength(prepared.options.length - 1);
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
