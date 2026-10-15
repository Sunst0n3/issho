// @vitest-environment node
// Core words (content/core-words.json, or its part files): validation, the build-time fields and
// the core-id lock that freezes ids at release (scripts/data/core-ids.lock.json).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoreWord } from '../src/lib/types.ts';
import { mergeContent, readContentSources } from './lib/content.ts';
import {
  CORE_POS,
  CORE_TOPICS,
  MAX_CORE_EN,
  REGISTERS,
  V1_SURVIVAL_IDS,
  checkCoreIdLock,
  coreUnit,
  deriveCoreWord,
  kanaCheckWords,
  makeCoreIdLock,
  type AuthoredCoreWord,
  type CoreIdLock,
} from './lib/core.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOCK = `${ROOT}scripts/data/core-ids.lock.json`;
const set = readContentSources(`${ROOT}content`, 'core-words', ROOT);
const merged = mergeContent('core-words', set.sources);
const words = merged.data as AuthoredCoreWord[];

describe('content core words', () => {
  it('validate with no errors, and every v1 survival word lives on', () => {
    expect(set.errors).toEqual([]);
    expect(merged.errors).toEqual([]);
    expect(merged.warnings.filter((w) => w.includes('survival'))).toEqual([]);
    const survival = new Set(words.map((w) => w.survival).filter(Boolean));
    expect(V1_SURVIVAL_IDS).toHaveLength(117);
    for (const id of V1_SURVIVAL_IDS) expect(survival.has(id), id).toBe(true);
  });

  it('run 1..N in order with unique ids', () => {
    expect(words.map((w) => w.order)).toEqual(words.map((_, i) => i + 1));
    expect(new Set(words.map((w) => w.id)).size).toBe(words.length);
  });

  it('give every word an English gloss, a register, a topic and use', () => {
    for (const w of words) {
      expect(w.en.length, w.id).toBeGreaterThan(0);
      expect(w.en.length, w.id).toBeLessThanOrEqual(MAX_CORE_EN);
      expect(REGISTERS, w.id).toContain(w.register);
      expect(CORE_POS, w.id).toContain(w.pos);
      expect(CORE_TOPICS, w.id).toContain(w.topic);
      expect(typeof w.use, w.id).toBe('boolean');
    }
  });

  it('accept written forms without kanji (Tシャツ)', () => {
    const report = mergeContent('core-words', [
      { file: 'x.json', data: [{ id: 'cw-0001', order: 1, kana: 'ティーシャツ', written: 'Tシャツ', en: 'T-shirt', pos: 'noun', register: 'both', topic: 'clothes', use: false }] },
    ]);
    expect(report.errors).toEqual([]);
  });
});

describe('build-time fields', () => {
  const units = [
    { id: 1, coreWordCeiling: 100 },
    { id: 2, coreWordCeiling: 250 },
  ];

  it('derive kanji from the written form, the unit from the ceilings and altKana from JMdict', () => {
    const w: AuthoredCoreWord = { id: 'cw-0120', order: 120, kana: 'たべもの', written: '食べ物', en: 'food', pos: 'noun', register: 'both', topic: 'food', use: true };
    expect(deriveCoreWord(w, units, ['たべもん', 'たべもの'])).toEqual({ ...w, kanji: ['食', '物'], unit: 2, altKana: ['たべもん'] });
    expect(deriveCoreWord({ ...w, written: '人々' }, units).kanji).toEqual(['人']);
    expect(deriveCoreWord({ ...w, written: undefined }, units).kanji).toEqual([]);
    expect(coreUnit(100, units)).toBe(1);
    expect(coreUnit(101, units)).toBe(2);
    expect(coreUnit(900, units)).toBe(2);
    expect(coreUnit(5, [])).toBe(1);
  });

  it('pick the 10 kana-check words: katakana food and drink first, by order, topped up from other katakana words', () => {
    const cw = (id: string, order: number, kana: string, topic: string) =>
      ({ id, order, kana, topic, en: kana, pos: 'noun', register: 'both', use: false, kanji: [], unit: 1 }) as CoreWord;
    const list = [
      cw('a', 3, 'コーヒー', 'drink'),
      cw('b', 1, 'テレビ', 'home'),
      cw('c', 2, 'パン', 'food'),
      cw('d', 4, 'すし', 'food'),
      cw('e', 5, 'パンや', 'shopping'),
    ];
    expect(kanaCheckWords(list, 3).map((w) => w.kana)).toEqual(['パン', 'コーヒー', 'テレビ']);
    expect(kanaCheckWords(list, 3)[0]).toEqual({ kana: 'パン', en: 'パン', ref: 'core:c' });
  });
});

describe('core id lock', () => {
  const words = [
    { id: 'cw-0001', kana: 'みず', written: '水' },
    { id: 'cw-0002', kana: 'ありがとう' },
  ];

  it('accepts the words it was made from, a reorder and new ids', () => {
    const lock = makeCoreIdLock(words);
    expect(lock).toEqual({ 'cw-0001': { kana: 'みず', written: '水' }, 'cw-0002': { kana: 'ありがとう' } });
    expect(checkCoreIdLock(lock, [...words].reverse())).toEqual([]);
    expect(checkCoreIdLock(lock, [...words, { id: 'cw-0003', kana: 'ひ' }])).toEqual([]);
    expect(checkCoreIdLock(lock, [{ id: 'cw-0001', kana: 'ミズ', written: '水' }, words[1]])).toEqual([]);
  });

  it('fails a swapped meaning or a removed id', () => {
    const lock = makeCoreIdLock(words);
    expect(checkCoreIdLock(lock, [{ id: 'cw-0001', kana: 'ひ', written: '火' }])).toEqual([
      'core id cw-0001 is locked as 水 みず but is now 火 ひ',
      'core id cw-0002 (ありがとう) is locked but no longer exists',
    ]);
  });

  it.runIf(existsSync(LOCK))('holds for the current core words', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as CoreIdLock;
    expect(checkCoreIdLock(lock, merged.data as AuthoredCoreWord[])).toEqual([]);
  });
});
