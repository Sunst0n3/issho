// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoreWord, Curriculum, WordEntry } from '../src/lib/types.ts';
import { MAX_UNIT_WORDS } from './lib/curriculum.ts';
import { WORD_OVERRIDES } from './lib/word-overrides.ts';

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));
const built =
  existsSync(`${DATA}curriculum.json`) &&
  existsSync(`${DATA}content/core-words.json`) &&
  (JSON.parse(readFileSync(`${DATA}curriculum.json`, 'utf8')) as { version?: number }).version === 2;
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
  const core = built ? read<CoreWord[]>('content/core-words.json') : [];
  const { units } = built ? read<Curriculum>('curriculum.json') : { units: [] };
  const wordById = new Map(words.map((w) => [w.id, w]));
  const coreById = new Map(core.map((c) => [c.id, c]));
  const unitOf = new Map(units.map((u) => [u.char, u]));
  /** The item ref of a JMdict entry: core:<id> when it is a core word. */
  const refOf = (id: string) => (wordById.get(id)?.core ? `core:${wordById.get(id)!.core}` : `word:${id}`);
  /** How the curriculum shows an entry: a core word under its own spelling and reading. */
  const shown = (id: string) => {
    const w = wordById.get(id)!;
    const c = w.core ? coreById.get(w.core) : undefined;
    return { written: c?.written ?? w.written, kana: c?.kana ?? w.kana };
  };
  const taught = (char: string) => {
    const u = unitOf.get(char)!;
    return [u.anchor, ...u.staged].map((ref) =>
      ref!.startsWith('core:') ? coreById.get(ref!.slice(5))!.written : wordById.get(ref!.slice(5))!.written,
    );
  };

  it('names words.json entries by id, with the spelling and reading the curriculum shows', () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
    for (const [, list] of entries) {
      for (const [id, written, kana] of list) {
        expect(wordById.has(id), `${written} (${id})`).toBe(true);
        expect(shown(id), `${written} (${id})`).toEqual({ written, kana });
      }
    }
  });

  it('is what each listed kanji teaches: anchor first, then staged words, none needing the fallback', () => {
    for (const [char, list] of entries) {
      const unit = unitOf.get(char)!;
      expect([unit.anchor, ...unit.staged], char).toEqual(list.map(([id]) => refOf(id)));
      for (const [id, written] of list) {
        for (const ch of wordById.get(id)!.kanji) {
          expect(unitOf.get(ch)!.index, `${ch} in ${written}`).toBeLessThanOrEqual(unit.index);
        }
      }
    }
  });

  it('fixes the picks the frequency ranking got wrong', () => {
    expect(taught('上')).toEqual(['上', '上がる']);
    expect(taught('下')).toEqual(['下', '下がる', '下げる']);
    expect(taught('行')).toEqual(['行く', '行う']);
    expect(taught('大')).toEqual(['大きい', '大人', '大会']);
    expect(taught('新')).toEqual(['新しい', '新年']);
    expect(taught('週')).toEqual(['今週', '来週', '先週']);
    expect(taught('面')).toEqual(['面白い']);
    expect(taught('夫')).toEqual(['夫']);
    expect(taught('達')).toContain('友達');
  });
});
