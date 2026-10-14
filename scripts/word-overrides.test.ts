// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Curriculum, WordEntry } from '../src/lib/types.ts';
import { MAX_UNIT_WORDS } from './lib/curriculum.ts';
import { WORD_OVERRIDES } from './lib/word-overrides.ts';

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));
const built = existsSync(`${DATA}curriculum.json`) && existsSync(`${DATA}words.json`);
const read = <T,>(file: string): T => JSON.parse(readFileSync(DATA + file, 'utf8')) as T;
const entries = Object.entries(WORD_OVERRIDES);

describe('WORD_OVERRIDES', () => {
  it('lists 1–3 words per kanji, each spelled with it, none listed twice', () => {
    const seen = new Set<string>();
    for (const [char, list] of entries) {
      expect(list.length, char).toBeGreaterThanOrEqual(1);
      expect(list.length, char).toBeLessThanOrEqual(MAX_UNIT_WORDS);
      // Two words spelled alike (空 そら / 空 から) would make the reading card ambiguous.
      expect(new Set(list.map(([, written]) => written)).size, char).toBe(list.length);
      for (const [id, written, kana] of list) {
        expect(id, written).toMatch(/^\d+$/);
        expect(written, id).toContain(char);
        expect(kana, written).toMatch(/^[ぁ-ゖァ-ヺー]+$/); // パン屋 is read パンや
        expect(seen.has(id), `${written} is listed twice`).toBe(false);
        seen.add(id);
      }
    }
  });
});

describe.skipIf(!built)('WORD_OVERRIDES in the generated data', () => {
  const words = built ? read<WordEntry[]>('words.json') : [];
  const { units } = built ? read<Curriculum>('curriculum.json') : { units: [] };
  const wordById = new Map(words.map((w) => [w.id, w]));
  const unitOf = new Map(units.map((u) => [u.char, u]));

  it('names words.json entries by id, with the spelling and reading they have there', () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
    for (const [, list] of entries) {
      for (const [id, written, kana] of list) {
        expect(wordById.get(id), `${written} (${id})`).toMatchObject({ written, kana });
      }
    }
  });

  it('is what each listed kanji teaches: no word needed the automatic fallback', () => {
    for (const [char, list] of entries) {
      const unit = unitOf.get(char)!;
      expect(unit.words, char).toEqual(list.map(([id]) => id));
      for (const [id, written] of list) {
        for (const ch of wordById.get(id)!.kanji) {
          expect(unitOf.get(ch)!.index, `${ch} in ${written}`).toBeLessThanOrEqual(unit.index);
        }
      }
    }
  });

  it('fixes the picks the frequency ranking got wrong', () => {
    const taught = (char: string) => unitOf.get(char)!.words.map((id) => wordById.get(id)!.written);
    expect(taught('上')).toEqual(['上', '上がる', '上げる']);
    expect(taught('下')).toEqual(['下', '下がる', '下げる']);
    expect(taught('行')).toEqual(['行く', '行う']);
    expect(taught('大')).toEqual(['大きい', '大人', '大会']);
    expect(taught('新')).toEqual(['新しい', '新年']);
    expect(taught('和')).toEqual(['和食', '和風']);
    expect(taught('週')).toEqual(['今週', '来週', '先週']);
    expect(taught('部')).toContain('部屋');
    expect(taught('面')).toContain('面白い');
    expect(taught('夫')).toContain('大丈夫');
    expect(taught('達')).toContain('友達');
    // 銀行 needs 銀, taught long after 行, so it comes with 銀.
    expect(taught('銀')).toContain('銀行');
  });
});
