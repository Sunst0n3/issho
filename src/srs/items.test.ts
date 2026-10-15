import { State } from 'ts-fsrs';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { db, updateSettings } from '../lib/db.ts';
import type { CardRecord, SuspendReason } from '../lib/types.ts';
import {
  cardTypesFor,
  countsAsNew,
  introduceItem,
  isIntroduced,
  markKnownMany,
  setPinned,
  shouldRetire,
  syncWriteRetirement,
  upgradeSpelling,
} from './items.ts';
import { at, fixtures, resetDb } from './test-fixtures.ts';

vi.mock('../lib/data.ts', async () => (await import('./test-fixtures.ts')).dataMock);

beforeEach(resetDb);

const NOW = at(2026, 3, 1, 9);

describe('card types', () => {
  it('has only the retired suspend reason', () => {
    expectTypeOf<SuspendReason>().toEqualTypeOf<'retired'>();
  });

  it('gives each item kind its cards', () => {
    expect({
      kana: cardTypesFor('kana', 'あ'),
      kanaRule: cardTypesFor('kanaRule', 'hira-yoon'),
      kanji: cardTypesFor('kanji', '水'),
      kanjiZeroWord: cardTypesFor('kanji', '乙', { zeroWord: true }),
      word: cardTypesFor('word', '1'),
      wordUse: cardTypesFor('word', '1', { use: true }),
      core: cardTypesFor('core', 'cw-0001'),
      coreUse: cardTypesFor('core', 'cw-0001', { use: true }),
      coreSpelled: cardTypesFor('core', 'cw-0001', { spelled: true }),
      coreUseSpelled: cardTypesFor('core', 'cw-0001', { use: true, spelled: true }),
      grammar: cardTypesFor('grammar', 'wa-desu'),
      grammarRecognition: cardTypesFor('grammar', 'passive', { recognitionOnly: true }),
      sentence: cardTypesFor('sentence', 's-1'),
    }).toMatchInlineSnapshot(`
      {
        "core": [
          "listen",
        ],
        "coreSpelled": [
          "listen",
          "read",
        ],
        "coreUse": [
          "listen",
          "produce",
        ],
        "coreUseSpelled": [
          "listen",
          "produce",
          "read",
        ],
        "grammar": [
          "comprehend",
          "build",
        ],
        "grammarRecognition": [
          "comprehend",
        ],
        "kana": [
          "read",
          "write",
        ],
        "kanaRule": [
          "read",
        ],
        "kanji": [
          "write",
        ],
        "kanjiZeroWord": [
          "write",
          "meaning",
        ],
        "sentence": [
          "cloze",
        ],
        "word": [
          "read",
        ],
        "wordUse": [
          "read",
          "produce",
        ],
      }
    `);
  });

  it('counts every kind but saved sentences as new', () => {
    expect(countsAsNew('kanji')).toBe(true);
    expect(countsAsNew('core')).toBe(true);
    expect(countsAsNew('sentence')).toBe(false);
  });
});

describe('introduceItem', () => {
  it('creates the item and its cards once', async () => {
    const first = await introduceItem('word', '1002', NOW, { ctx: { use: true } });
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({ id: 'word:1002', kind: 'word', key: '1002', via: 'lesson' });
    expect(first.cards.map((c) => [c.id, c.state])).toEqual([['word:1002|read', State.New], ['word:1002|produce', State.New]]);
    const second = await introduceItem('word', '1002', new Date(NOW.getTime() + 1000), { ctx: { use: true } });
    expect(second.created).toBe(false);
    expect(await db.cards.count()).toBe(2);
    expect(await isIntroduced('word:1002')).toBe(true);
    expect(await isIntroduced('word:9999')).toBe(false);
  });

  it('sets spelledAt for a core word introduced with its kanji spelling', async () => {
    const { item } = await introduceItem('core', 'cw-0040', NOW, { ctx: { spelled: true }, via: 'staged' });
    expect(item.spelledAt).toEqual(NOW);
    expect(item.via).toBe('staged');
  });
});

describe('upgradeSpelling', () => {
  it('adds the read card once and sets spelledAt', async () => {
    await introduceItem('core', 'cw-0040', at(2026, 2, 1), { ctx: { use: true } });
    const up = await upgradeSpelling('cw-0040', NOW);
    expect(up.created).toBe(true);
    expect(up.cards.map((c) => c.id)).toEqual(['core:cw-0040|read']);
    expect(up.item.spelledAt).toEqual(NOW);
    const again = await upgradeSpelling('cw-0040', new Date(NOW.getTime() + 1000));
    expect(again.created).toBe(false);
    expect((await db.items.get('core:cw-0040'))?.spelledAt).toEqual(NOW);
    expect(await db.cards.where('itemId').equals('core:cw-0040').count()).toBe(3);
  });

  it('refuses a word that was never introduced', async () => {
    await expect(upgradeSpelling('cw-0042', NOW)).rejects.toThrow(/not introduced/);
  });
});

describe('markKnownMany', () => {
  it('introduces items via placement and puts their cards in Review, spread over the stability', async () => {
    await markKnownMany([{ kind: 'kana', key: 'あ' }, { kind: 'kana', key: 'い' }, { kind: 'kana', key: 'あ' }], NOW, 10);
    const cards = await db.cards.toArray();
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.state).toBe(State.Review);
      expect(card.stability).toBe(10);
      const days = (card.due.getTime() - NOW.getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(10);
    }
    expect((await db.items.get('kana:あ'))?.via).toBe('placement');
  });

  it('leaves cards already in Review alone', async () => {
    await introduceItem('kana', 'あ', NOW);
    const review: CardRecord = { ...(await db.cards.get('kana:あ|read'))!, state: State.Review, stability: 40 };
    await db.cards.put(review);
    await markKnownMany([{ kind: 'kana', key: 'あ' }], NOW, 10);
    expect((await db.cards.get('kana:あ|read'))?.stability).toBe(40);
    expect((await db.cards.get('kana:あ|write'))?.stability).toBe(10);
  });
});

describe('write retirement', () => {
  const card = (stability: number) => ({ kind: 'kanji' as const, type: 'write' as const, stability });

  it('retires a stable write card past the write list unless pinned', () => {
    expect(shouldRetire(card(22), 501, 500, false)).toBe(true);
    expect(shouldRetire(card(22), 499, 500, false)).toBe(false);
    expect(shouldRetire(card(20), 501, 500, false)).toBe(false);
    expect(shouldRetire(card(22), 501, 500, true)).toBe(false);
    expect(shouldRetire({ kind: 'word', type: 'read', stability: 99 }, 501, 500, false)).toBe(false);
  });

  async function stableKanji(char: string, stability: number) {
    await introduceItem('kanji', char, NOW);
    const write = (await db.cards.get(`kanji:${char}|write`))!;
    await db.cards.put({ ...write, state: State.Review, stability });
  }

  it('retires and restores cards as the write list changes, and on pinning', async () => {
    // Fixture ranks: 日 6, 人 13.
    await stableKanji('日', 30);
    await stableKanji('人', 30);
    await stableKanji('本', 5);
    await updateSettings({ writeList: 8 });
    expect(await syncWriteRetirement(NOW)).toEqual({ retired: 1, restored: 0 });
    expect((await db.cards.get('kanji:人|write'))?.suspended).toBe('retired');
    expect((await db.cards.get('kanji:日|write'))?.suspended).toBeUndefined();
    expect((await db.cards.get('kanji:本|write'))?.suspended).toBeUndefined();
    expect(await syncWriteRetirement(NOW)).toEqual({ retired: 0, restored: 0 });

    await setPinned('人', true);
    expect((await db.cards.get('kanji:人|write'))?.suspended).toBeUndefined();
    expect((await db.items.get('kanji:人'))?.pinned).toBe(true);
    await setPinned('人', false);
    expect((await db.cards.get('kanji:人|write'))?.suspended).toBe('retired');

    await updateSettings({ writeList: 500 });
    expect(await syncWriteRetirement(NOW)).toEqual({ retired: 0, restored: 1 });
    expect((await db.cards.get('kanji:人|write'))?.suspended).toBeUndefined();
    expect(fixtures.curriculum.units.find((u) => u.char === '人')?.index).toBe(12);
  });
});
