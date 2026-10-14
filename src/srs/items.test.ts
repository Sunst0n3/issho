import { Rating, State } from 'ts-fsrs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/db.ts';
import { DAY_MS } from './days.ts';
import { cardTypesFor, introduceItem, isIntroduced, knownDueOffsetDays, markKnown, markKnownMany } from './items.ts';
import { gradeCard } from './scheduler.ts';
import { at, resetDb } from './test-fixtures.ts';

beforeEach(resetDb);

const NOW = at(2026, 10, 14, 9);
const newItemsToday = async () => (await db.days.get('2026-10-14'))?.newItems ?? 0;

describe('cardTypesFor', () => {
  it('gives each kind its cards', () => {
    expect(cardTypesFor('kana', 'あ')).toEqual(['read', 'write']);
    expect(cardTypesFor('kana', 'ア')).toEqual(['read', 'write']);
    expect(cardTypesFor('radical', '氵')).toEqual(['meaning']);
    expect(cardTypesFor('kanji', '水')).toEqual(['meaning', 'reading', 'write']);
    expect(cardTypesFor('word', '1001')).toEqual(['reading', 'meaning']);
    expect(cardTypesFor('vocab', 'sw-hai')).toEqual(['meaning', 'recall']);
    expect(cardTypesFor('grammar', 'wa-desu')).toEqual(['drill']);
    expect(cardTypesFor('sentence', 's-0001')).toEqual(['read']);
  });

  it('gives yōon a read card only', () => {
    expect(cardTypesFor('kana', 'きゃ')).toEqual(['read']);
    expect(cardTypesFor('kana', 'ショ')).toEqual(['read']);
    expect(cardTypesFor('kana', 'ぎゅ')).toEqual(['read']);
  });
});

describe('introduceItem', () => {
  it('creates the item and its new cards and counts it as new today', async () => {
    const { item, cards, created } = await introduceItem('kanji', '水', NOW);
    expect(created).toBe(true);
    expect(item).toMatchObject({ id: 'kanji:水', kind: 'kanji', key: '水' });
    expect(item.introducedAt).toBeInstanceOf(Date);
    expect(cards.map((c) => c.id)).toEqual(['kanji:水|meaning', 'kanji:水|reading', 'kanji:水|write']);
    expect(cards.every((c) => c.state === State.New && c.due.getTime() === NOW.getTime())).toBe(true);
    expect(await db.cards.where('itemId').equals('kanji:水').count()).toBe(3);
    expect(await newItemsToday()).toBe(1);
  });

  it('is idempotent', async () => {
    await introduceItem('kana', 'あ', NOW);
    await gradeCard('kana:あ|read', Rating.Good, { durationMs: 1, mode: 'choice', now: NOW });
    const again = await introduceItem('kana', 'あ', at(2026, 10, 14, 18));

    expect(again.created).toBe(false);
    expect(again.item.introducedAt.getTime()).toBe(NOW.getTime());
    expect(again.cards.find((c) => c.type === 'read')!.state).toBe(State.Learning);
    expect(await db.items.count()).toBe(1);
    expect(await db.cards.count()).toBe(2);
    expect(await newItemsToday()).toBe(1);
  });

  it('is idempotent when called twice at once', async () => {
    const results = await Promise.all([introduceItem('kana', 'い', NOW), introduceItem('kana', 'い', NOW)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.cards.count()).toBe(2);
    expect(await newItemsToday()).toBe(1);
  });

  it('restores missing cards of an existing item without counting it again', async () => {
    await introduceItem('kanji', '火', NOW);
    await db.cards.delete('kanji:火|write');
    const { created, cards } = await introduceItem('kanji', '火', NOW);
    expect(created).toBe(false);
    expect(cards.map((c) => c.type)).toEqual(['meaning', 'reading', 'write']);
    expect(await db.cards.count()).toBe(3);
    expect(await newItemsToday()).toBe(1);
  });

  it("doesn't count words or saved sentences toward the day's new items", async () => {
    await introduceItem('word', '1001', NOW);
    await introduceItem('sentence', 's-0001', NOW);
    expect(await newItemsToday()).toBe(0);
    await introduceItem('vocab', 'sw-hai', NOW);
    await introduceItem('radical', '氵', NOW);
    await introduceItem('grammar', 'wa-desu', NOW);
    expect(await newItemsToday()).toBe(3);
  });

  it('creates only a read card for yōon', async () => {
    const { cards } = await introduceItem('kana', 'きゃ', NOW);
    expect(cards.map((c) => c.id)).toEqual(['kana:きゃ|read']);
  });
});

describe('markKnown', () => {
  it('introduces the item with review cards due within 1–14 days, not counted as new', async () => {
    await markKnown('kanji', '山', NOW);
    expect(await isIntroduced('kanji:山')).toBe(true);
    const cards = await db.cards.where('itemId').equals('kanji:山').toArray();
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.state).toBe(State.Review);
      expect(card.due).toBeInstanceOf(Date);
      const days = (card.due.getTime() - NOW.getTime()) / DAY_MS;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(14);
      expect(card.stability).toBeGreaterThan(0);
      expect(card.last_review).toEqual(NOW);
    }
    expect(await newItemsToday()).toBe(0);
  });

  it('produces cards FSRS can keep scheduling', async () => {
    await markKnown('kana', 'あ', NOW);
    const card = (await db.cards.get('kana:あ|read'))!;
    const later = new Date(card.due.getTime() + 60_000);
    const next = await gradeCard(card.id, Rating.Good, { durationMs: 1, mode: 'choice', now: later });
    expect(next.state).toBe(State.Review);
    expect(next.due.getTime() - later.getTime()).toBeGreaterThan(7 * DAY_MS);
  });

  it('graduates cards still learning but leaves reviewed cards alone', async () => {
    await introduceItem('kana', 'か', NOW);
    await db.cards.update('kana:か|write', { state: State.Review, stability: 3, due: at(2026, 10, 16) });
    await markKnown('kana', 'か', NOW);
    expect((await db.cards.get('kana:か|read'))!.state).toBe(State.Review);
    expect(await db.cards.get('kana:か|write')).toMatchObject({ stability: 3, due: at(2026, 10, 16) });
    expect(await db.items.count()).toBe(1);
  });

  it('spreads a big batch over the coming days', async () => {
    const chars = [...'あいうえおかきくけこさしすせそたちつてとなにぬねの'];
    await markKnownMany([...chars.map((key) => ({ kind: 'kana' as const, key })), { kind: 'kana', key: 'あ' }], NOW);
    expect(await db.items.count()).toBe(chars.length);
    const offsets = (await db.cards.toArray()).map((c) => Math.round((c.due.getTime() - NOW.getTime()) / DAY_MS));
    expect(new Set(offsets).size).toBeGreaterThanOrEqual(10);
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(14);
  });

  it('spreads deterministically per card', () => {
    expect(knownDueOffsetDays('kana:あ|read')).toBe(knownDueOffsetDays('kana:あ|read'));
  });
});

describe('isIntroduced', () => {
  it('reports whether the item exists', async () => {
    expect(await isIntroduced('kana:あ')).toBe(false);
    await introduceItem('kana', 'あ', NOW);
    expect(await isIntroduced('kana:あ')).toBe(true);
  });
});
