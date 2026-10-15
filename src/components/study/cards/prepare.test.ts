import { createEmptyCard } from 'ts-fsrs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardId, db } from '../../../lib/db.ts';
import { parseRuby } from '../../../lib/ruby.ts';
import type { CardRecord, CardType, ItemKind } from '../../../lib/types.ts';
import { seededRandom } from '../../../srs/random.ts';
import type { KnownWords } from '../../../srs/readListen.ts';
import { CURRICULUM, KANJI, resetStudyDb } from '../test-utils.tsx';
import {
  blankKana,
  blankKanji,
  CLOZE_GAP,
  cueTexts,
  prepareCard,
  splitCue,
  stripRubyOf,
  TYPED_BUILD_FROM,
  type PrepareContext,
} from './prepare.ts';
import type { PreparedCard } from './types.ts';

vi.mock('../../../lib/data.ts', async () => (await import('../test-utils.tsx')).dataMock);

const KNOWN = new Set(['word:w-mizu', 'word:w-hon', 'word:w-nihon', 'core:cw-0001']);
const known: KnownWords = { isKnown: (ref) => KNOWN.has(ref), introducedDay: (ref) => (KNOWN.has(ref) ? '2026-10-01' : undefined) };

function ctx(over: Partial<PrepareContext> = {}): PrepareContext {
  return { courseDay: 20, inSprint: false, taught: new Set(), grammarIntroduced: 5, handsBusy: false, known, random: seededRandom(1), ...over };
}

function card(kind: ItemKind, key: string, type: CardType, reps = 0): CardRecord {
  const itemId = `${kind}:${key}`;
  return { ...createEmptyCard(new Date('2026-10-15T09:00:00')), reps, id: cardId(itemId, type), itemId, kind, type };
}

async function prep(kind: ItemKind, key: string, type: CardType, over: Partial<PrepareContext> = {}, reps = 0): Promise<PreparedCard> {
  const p = await prepareCard(card(kind, key, type, reps), ctx(over));
  if (!p) throw new Error(`no card for ${kind}:${key}|${type}`);
  return p;
}

beforeEach(async () => {
  await resetStudyDb();
});

describe('blanks', () => {
  it('blanks every occurrence of the kanji', () => {
    expect(blankKanji('日本', '日')).toBe('□本');
    expect(blankKanji('日々日', '日')).toBe('□々□');
    expect(blankKanji('本', '日')).toBe('本');
  });

  it('blanks a kana only where it stands alone', () => {
    expect(blankKana('かさ', 'か')).toBe('□さ');
    expect(blankKana('きゃく', 'き')).toBe('きゃく');
    expect(blankKana('ききゃ', 'き')).toBe('□きゃ');
  });

  it('splits a sentence around a word, never leaving a reading on it', () => {
    expect(splitCue('{水|みず}です。', '水')).toEqual({ before: '', target: '水', after: 'です。' });
    // The first occurrence, or the one at a given offset (the word's own token).
    expect(splitCue('{日本|にほん}の{本|ほん}です。', '本')).toEqual({ before: '日', target: '本', after: 'の本です。' });
    expect(splitCue('{日本|にほん}の{本|ほん}です。', '本', 3)).toEqual({ before: '日本の', target: '本', after: 'です。' });
    expect(splitCue('あ{水曜日|すいようび}', '水曜')).toEqual({ before: 'あ', target: '水曜', after: '日' });
    expect(splitCue('{水|みず}です。', '火')).toBeNull();
    expect(stripRubyOf('{水|みず}と{水|みず}と{木|き}', '水')).toBe('水と水と{木|き}');
  });
});

describe('prepareCard', () => {
  it('writes the kanji write prompt with the anchor blanked and never the kanji itself', async () => {
    for (const unit of CURRICULUM.units) {
      const p = await prep('kanji', unit.char, 'write');
      expect(p.view).toBe('kanji-write');
      if (p.view !== 'kanji-write') continue;
      const shown = [p.blanked ?? '', p.reading, ...cueTexts(p).texts].join('');
      expect(shown, unit.char).not.toContain(unit.char);
      expect(p.options).toEqual([]);
    }
    const nihon = await prep('kanji', '日', 'write');
    expect(nihon).toMatchObject({ blanked: '□本', reading: 'にほん' });
    // A zero-word kanji: its keyword and first reading.
    expect(await prep('kanji', '曜', 'write')).toMatchObject({ reading: 'ヨウ' });
    expect((await prep('kanji', '曜', 'write') as Extract<PreparedCard, { view: 'kanji-write' }>).blanked).toBeUndefined();
  });

  it('never gives the card’s own word a reading, for every view', async () => {
    await db.items.put({ id: 'core:cw-0002', kind: 'core', key: 'cw-0002', introducedAt: new Date(), spelledAt: new Date() });
    await db.savedSentences.put({ id: 's-nihon', jp: '{日本|にほん}の{本|ほん}です。', en: 'It is a Japanese book.', savedAt: new Date(), source: 'reading', blank: { surface: '本', reading: 'ほん', ref: 'word:w-hon' } });
    const all = await Promise.all([
      prep('kana', 'か', 'read', { inSprint: true }),
      prep('kana', 'か', 'read'),
      prep('kana', 'か', 'write', { inSprint: true }),
      prep('kana', 'か', 'write'),
      prep('kanaRule', 'hira-dakuten', 'read'),
      prep('kanji', '水', 'write'),
      prep('kanji', '曜', 'meaning'),
      prep('word', 'w-nihon', 'read'),
      prep('word', 'w-hon', 'read'),
      prep('core', 'cw-0002', 'produce'),
      prep('core', 'cw-0002', 'listen'),
      prep('grammar', 'wa-desu', 'comprehend'),
      prep('grammar', 'wa-desu', 'build'),
      prep('sentence', 's-nihon', 'cloze'),
    ]);
    expect(new Set(all.map((p) => p.view))).toEqual(new Set([
      'kana-read', 'kana-write', 'kana-rule', 'kanji-write', 'kanji-meaning', 'word-read', 'produce', 'listen',
      'grammar-comprehend', 'grammar-build', 'cloze',
    ]));
    for (const p of all) {
      const { texts, target } = cueTexts(p);
      if (!target) continue;
      for (const text of texts) {
        for (const seg of parseRuby(text)) {
          if (seg.reading === undefined) continue;
          // No reading over the word wherever it appears (another word that only shares a kanji may keep its own).
          expect(seg.text.includes(target), `${p.view}: ${text}`).toBe(false);
        }
      }
      // Writing cards never show what is to be written.
      if (p.view === 'kanji-write' || p.view === 'kana-write') expect(texts.join(''), p.view).not.toContain(target);
    }
  });

  it('reads a word inside a known carrier sentence, underlined and without its reading', async () => {
    const p = await prep('word', 'w-nihon', 'read');
    expect(p.view).toBe('word-read');
    if (p.view !== 'word-read') return;
    expect(p.carrier?.id).toBe('s-nihon');
    expect(p.cue).toEqual({ before: '', target: '日本', after: 'の{本|ほん}です。' });
    expect(p.options).toHaveLength(4);
    expect(p.options).toContain('にほん');
    // A word with no known carrier stands alone.
    const alone = await prep('word', 'w-ike', 'read');
    expect(alone).toMatchObject({ view: 'word-read', cue: { before: '', target: '池', after: '' } });
    // The word's own token is underlined, not an earlier word that contains it.
    expect(await prep('word', 'w-hon', 'read')).toMatchObject({ cue: { before: '日本の', target: '本', after: 'です。' } });
    expect((alone as Extract<PreparedCard, { view: 'word-read' }>).carrier).toBeUndefined();
  });

  it('shows a core word in kana until it is spelled', async () => {
    await db.items.put({ id: 'core:cw-0002', kind: 'core', key: 'cw-0002', introducedAt: new Date() });
    expect(await prep('core', 'cw-0002', 'listen')).toMatchObject({ view: 'listen', display: 'たべる' });
    await db.items.update('core:cw-0002', { spelledAt: new Date() });
    expect(await prep('core', 'cw-0002', 'listen')).toMatchObject({ display: '{食べる|たべる}' });
  });

  it('takes romaji on kana read cards only during the sprint, and makes write cards sound-only then', async () => {
    expect(await prep('kana', 'か', 'read', { inSprint: true })).toMatchObject({ view: 'kana-read', mode: 'romaji', answer: 'ka' });
    expect(await prep('kana', 'か', 'read')).toMatchObject({ view: 'kana-read', mode: 'word', answer: 'かさ' });
    const sprintWrite = await prep('kana', 'か', 'write', { inSprint: true });
    expect(sprintWrite).toMatchObject({ view: 'kana-write', prompt: 'sound' });
    expect(JSON.stringify({ ...sprintWrite, kana: undefined, card: undefined })).not.toMatch(/"ka"/);
    expect(await prep('kana', 'か', 'write')).toMatchObject({ prompt: 'word', blanked: '□さ' });
    // お and を sound alike: a sound-only prompt names the row.
    expect(await prep('kana', 'を', 'write', { inSprint: true })).toMatchObject({ row: 'わ' });
    // The romaji choices never offer a second right answer (を is also "o").
    const wo = await prep('kana', 'を', 'read', { inSprint: true });
    expect(wo.options).not.toContain('o');
  });

  it('rotates comprehend examples: never one of the last two shown, and never 0–2 within the first n − 3 reviews', async () => {
    const n = 9;
    const shown: number[] = [];
    for (let reps = 0; reps <= 20; reps++) {
      const p = await prep('grammar', 'wa-desu', 'comprehend', {}, reps);
      if (p.view !== 'grammar-comprehend') throw new Error(p.view);
      expect(shown.slice(-2)).not.toContain(p.exampleIndex);
      if (reps < n - 3) expect(p.exampleIndex).toBeGreaterThanOrEqual(3);
      shown.push(p.exampleIndex);
    }
  });

  it('builds with tiles until 60 grammar points are introduced, then typed with choices behind "Show options"', async () => {
    const tiles = await prep('grammar', 'wa-desu', 'build', { grammarIntroduced: TYPED_BUILD_FROM - 1 });
    expect(tiles).toMatchObject({ view: 'grammar-build', tiles: true, itemIndex: 1, options: [] });
    if (tiles.view === 'grammar-build') expect(tiles.shuffledTiles).not.toEqual(tiles.item.tiles);
    const typed = await prep('grammar', 'wa-desu', 'build', { grammarIntroduced: TYPED_BUILD_FROM });
    expect(typed).toMatchObject({ tiles: false });
    expect(typed.options.length).toBeGreaterThan(1);
    expect(typed.options).toContain(typed.answer);
  });

  it('blanks the cloze word and asks for its reading', async () => {
    await db.savedSentences.put({ id: 's-mizu', jp: '{水|みず}です。', en: 'It is water.', savedAt: new Date(), source: 'reading', blank: { surface: '水', reading: 'みず', ref: 'word:w-mizu' } });
    const p = await prep('sentence', 's-mizu', 'cloze');
    expect(p).toMatchObject({ view: 'cloze', cue: { before: '', target: CLOZE_GAP, after: 'です。' }, answer: 'みず' });
  });

  it('carries the learner’s own hook, and nothing for a card whose data is missing', async () => {
    await db.items.put({ id: 'kanji:水', kind: 'kanji', key: '水', introducedAt: new Date(), customMnemonic: 'My hook' });
    expect((await prep('kanji', '水', 'write')).customMnemonic).toBe('My hook');
    expect(await prepareCard(card('kanji', '火', 'write'), ctx())).toBeNull();
    expect(Object.keys(KANJI)).not.toContain('火');
  });
});
