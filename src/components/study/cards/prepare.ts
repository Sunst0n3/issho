// Loads what a review card shows: its content, the cue text (the card's own word never gets a reading) and the
// choices behind "Show options".

import { db, getSettings } from '../../../lib/db.ts';
import {
  loadAccent,
  loadCoreWords,
  loadCurriculum,
  loadGrammarIndex,
  loadKana,
  loadKanaExamples,
  loadKanaRules,
  loadKanji,
  loadSentences,
  loadWordInfo,
  loadWords,
  type KanaExample,
  type WordInfo,
} from '../../../lib/data.ts';
import { isKanji, parseRuby, rubyToPlain, type RubySegment } from '../../../lib/ruby.ts';
import type { CardRecord, RubyText, WordEntry } from '../../../lib/types.ts';
import { choicesFrom, shuffle, toHiragana } from '../../../srs/answers.ts';
import { loadCourseSnapshot, taughtKana } from '../../../srs/course.ts';
import type { LeakMask } from '../../../srs/planner.ts';
import { exampleSentenceFor, loadKnownWords, type KnownWords } from '../../../srs/readListen.ts';
import { cleanReading } from '../format.ts';
import { kanaSoundRow } from '../learn/data.ts';
import type { PreparedCard, SplitCue } from './types.ts';

export const OPTION_COUNT = 4;
/** Kana that are also particles, said differently then: は "wa", へ "e", を "o". */
const PARTICLE_SOUND: Record<string, string> = { は: 'wa', へ: 'e', を: 'o' };
/** Basic kana that sound the same (お and を are both "o"): the read card leaves the twin's romaji out of its choices. */
const SOUND_TWINS: Record<string, string> = { お: 'を', を: 'お', オ: 'ヲ', ヲ: 'オ' };
/** Words up to this JMdict rank are common enough to make fair distractors. */
const COMMON_RANK = 30;
/** The blank in a cloze sentence. */
export const CLOZE_GAP = '＿＿';
/** The box a written prompt shows instead of the character to write. */
export const BLANK = '□';

type Random = () => number;

export interface PrepareContext {
  courseDay: number;
  /** CourseSnapshot.inSprint: kana-read cards take romaji and kana-write cards are sound-only while true. */
  inSprint: boolean;
  /** Taught kana for <KanaText>'s romaji helper (taughtKana()). */
  taught: ReadonlySet<string>;
  grammarIntroduced: number;
  handsBusy: boolean;
  known: KnownWords;
  random?: () => number;
}

/** The context for preparing cards now, from the learner's progress and settings. */
export async function loadPrepareContext(now: Date = new Date()): Promise<PrepareContext> {
  const [snapshot, taught, known, settings, grammarIntroduced] = await Promise.all([
    loadCourseSnapshot(now),
    taughtKana(now),
    loadKnownWords(now),
    getSettings(),
    db.items.where('kind').equals('grammar').count(),
  ]);
  return { courseDay: snapshot.courseDay, inSprint: snapshot.inSprint, taught, grammarIntroduced, handsBusy: settings.handsBusy, known };
}

/** Grammar build items are tiles until this many grammar points are introduced, then typed. */
export const TYPED_BUILD_FROM = 60;

/** '□本' for anchor 日本 and kanji 日 (every occurrence of the kanji). Never contains the target kanji. */
export function blankKanji(written: string, char: string): string {
  return written.split(char).join(BLANK);
}

const SMALL_AFTER = /^[ゃゅょぁぃぅぇぉャュョァィゥェォ]/;

/** The word with each stand-alone occurrence of the kana as □ (か in かさ → □さ; not the き of きゃ). */
export function blankKana(word: string, char: string): string {
  let out = '';
  let at = 0;
  for (let i = word.indexOf(char); i >= 0; i = word.indexOf(char, i + char.length)) {
    if ([...char].length === 1 && SMALL_AFTER.test(word.slice(i + char.length))) continue;
    out += word.slice(at, i) + BLANK;
    at = i + char.length;
  }
  return out + word.slice(at);
}

/** Segments back to ruby markup. */
function toRuby(segs: readonly RubySegment[]): RubyText {
  return segs.map((s) => (s.reading === undefined ? s.text : `{${s.text}|${s.reading}}`)).join('');
}

/** Ruby markup with the reading dropped from every segment that overlaps an occurrence of `surface`. */
export function stripRubyOf(jp: RubyText, surface: string): RubyText {
  if (!surface) return jp;
  const segs = parseRuby(jp);
  const plain = segs.map((s) => s.text).join('');
  const covered = new Set<number>();
  for (let i = plain.indexOf(surface); i >= 0; i = plain.indexOf(surface, i + 1)) {
    for (let k = i; k < i + surface.length; k++) covered.add(k);
  }
  let pos = 0;
  return toRuby(segs.map((s) => {
    const start = pos;
    pos += s.text.length;
    if (s.reading === undefined) return s;
    for (let k = start; k < pos; k++) if (covered.has(k)) return { text: s.text };
    return s;
  }));
}

/**
 * The sentence around one occurrence of `surface` (at plain-text offset `at` when given and right, else the first):
 * the word itself as plain text, the rest as ruby markup with the word's readings removed wherever else it occurs.
 * Null when the word is not in the sentence.
 */
export function splitCue(jp: RubyText, surface: string, at?: number): SplitCue | null {
  const segs = parseRuby(jp);
  const plain = segs.map((s) => s.text).join('');
  const start = at !== undefined && plain.startsWith(surface, at) ? at : plain.indexOf(surface);
  if (!surface || start < 0) return null;
  const end = start + surface.length;
  const before: RubySegment[] = [];
  const after: RubySegment[] = [];
  let pos = 0;
  for (const s of segs) {
    const from = pos;
    pos += s.text.length;
    if (pos <= start) before.push(s);
    else if (from >= end) after.push(s);
    else {
      // A segment the word cuts through loses its reading: the reading would cover the word too.
      if (from < start) before.push({ text: s.text.slice(0, start - from) });
      if (pos > end) after.push({ text: s.text.slice(end - from) });
    }
  }
  return { before: stripRubyOf(toRuby(before), surface), target: surface, after: stripRubyOf(toRuby(after), surface) };
}

/** Plain-text offset of the first token with this ref (tokens spell the sentence in order). */
export function tokenOffset(tokens: readonly { s: string; ref?: string }[], ref: string): number | undefined {
  let at = 0;
  for (const t of tokens) {
    if (t.ref === ref) return at;
    at += t.s.length;
  }
  return undefined;
}

/** The Japanese a card shows before it is answered, and the word it asks about (for checking that word never gets ruby). */
export function cueTexts(p: PreparedCard): { texts: RubyText[]; target?: string } {
  switch (p.view) {
    case 'kana-read': return { texts: [p.word?.kana ?? p.kana.char], target: p.word?.kana ?? p.kana.char };
    case 'kana-write': return { texts: p.blanked ? [p.blanked] : [], target: p.kana.char };
    case 'kana-rule': return { texts: [p.word.kana], target: p.word.kana };
    case 'kanji-write': return { texts: p.blanked ? [p.blanked, p.reading] : [p.reading], target: p.kanji.char };
    case 'kanji-meaning': return { texts: [p.kanji.char], target: p.kanji.char };
    case 'word-read':
    case 'cloze': return { texts: [p.cue.before, p.cue.target, p.cue.after], target: p.view === 'cloze' ? p.sentence.blank.surface : p.word.written };
    case 'produce':
    case 'listen': return { texts: [], target: p.word.written };
    case 'grammar-comprehend': return { texts: [p.example.jp] };
    case 'grammar-build': return { texts: p.tiles ? p.shuffledTiles : [] };
  }
}

/** Distinct options: the answer plus up to 3 from `tiers` (in order, shuffled within each), compared by `key`. */
function options(answer: string, tiers: readonly (readonly string[])[], random: Random, exclude: readonly string[] = [], key = (s: string) => s): string[] {
  const seen = new Set([key(answer), ...exclude.map(key)]);
  const picked: string[] = [];
  for (const tier of tiers) {
    for (const option of shuffle(tier, random)) {
      if (picked.length >= OPTION_COUNT - 1) break;
      const k = key(option);
      if (seen.has(k)) continue;
      seen.add(k);
      picked.push(option);
    }
  }
  return choicesFrom(answer, picked, OPTION_COUNT, key, random);
}

const kanaLength = (s: string) => [...s].length;

/**
 * Kana options for a reading: readings of common words of about the same length, those sharing a kanji with the
 * answer's word first. Words written like the answer are left out (they would be a second right answer).
 */
export async function readingOptions(
  answer: string,
  { kanji = [], written, exclude = [] }: { kanji?: readonly string[]; written?: string; exclude?: readonly string[] },
  random: Random = Math.random,
): Promise<string[]> {
  const words = await loadWords();
  const len = kanaLength(answer);
  const near = (w: WordEntry) => Math.abs(kanaLength(w.kana) - len) <= 1 && w.written !== written;
  const common = words.filter((w) => w.freqRank <= COMMON_RANK && near(w));
  const related = kanji.length ? common.filter((w) => w.kanji.some((k) => kanji.includes(k))) : [];
  const sameLength = common.filter((w) => kanaLength(w.kana) === len);
  const tiers = [related.slice(0, 40), sameLength, common].map((tier) => tier.map((w) => w.kana));
  return options(answer, tiers, random, exclude, toHiragana);
}

/** Core-word kana for produce choices: the same part of speech and topic first. */
async function produceOptions(word: WordInfo, random: Random): Promise<string[]> {
  const core = await loadCoreWords();
  const others = core.filter((c) => c.kana !== word.kana);
  const pos = word.core?.pos;
  const topic = word.core?.topic;
  const tiers = [
    others.filter((c) => c.pos === pos && c.topic === topic),
    others.filter((c) => c.pos === pos),
    others,
  ].map((tier) => tier.map((c) => c.kana));
  return options(word.kana, tiers, random, word.readings, toHiragana);
}

/** Reading shown with a zero-word kanji's write prompt: its first kun reading, else its first on reading. */
export function zeroWordReading(kanji: { kun: readonly string[]; on: readonly string[] }): string {
  if (kanji.kun.length) return cleanReading(kanji.kun[0]);
  return kanji.on[0] ?? '';
}

/** The tiles in an order that isn't already the answer (when the tiles allow it). */
export function shuffleTiles(tiles: readonly string[], random: Random): string[] {
  if (new Set(tiles).size < 2) return [...tiles];
  for (let i = 0; i < 12; i++) {
    const out = shuffle(tiles, random);
    if (out.join('\u0000') !== tiles.join('\u0000')) return out;
  }
  return [...tiles.slice(1), tiles[0]];
}

const keyOf = (card: CardRecord) => card.itemId.slice(card.kind.length + 1);

/** The word as ruby markup: `{written|kana}` once it is spelled (always for a JMdict word), else its kana. */
export function wordDisplay(word: Pick<WordInfo, 'written' | 'kana'>, spelled: boolean): RubyText {
  return spelled && word.written !== word.kana ? `{${word.written}|${word.kana}}` : word.kana;
}

/**
 * The word as a card may show it once answered: its spelling, unless one of its kanji is still to be written from
 * memory today (§3.2.4 leak guard: the kanji's write card asks it), then its kana.
 */
export function shownWord(display: RubyText, word: Pick<WordInfo, 'kana' | 'kanji'>, mask?: Pick<LeakMask, 'kanji'>): RubyText {
  return mask && word.kanji.some((k) => mask.kanji.has(k)) ? word.kana : display;
}

/**
 * Ruby markup for each piece of a sentence (grammar build tiles spell `jp` in order): a piece keeps the reading of each
 * word it holds whole, so a kanji the learner hasn't met can carry its furigana on the tile too.
 */
export function piecesRuby(jp: RubyText, pieces: readonly string[]): RubyText[] {
  const segs = parseRuby(jp);
  const plain = segs.map((seg) => seg.text).join('');
  let cursor = 0;
  return pieces.map((piece) => {
    let start = plain.indexOf(piece, cursor);
    if (start < 0) start = plain.indexOf(piece);
    if (!piece || start < 0) return piece;
    const end = start + piece.length;
    cursor = end;
    const out: RubySegment[] = [];
    let pos = 0;
    for (const seg of segs) {
      const from = pos;
      pos += seg.text.length;
      if (pos <= start || from >= end) continue;
      // A word the piece holds whole keeps its reading; one it cuts through is plain text.
      if (from >= start && pos <= end) out.push(seg);
      else out.push({ text: seg.text.slice(Math.max(0, start - from), Math.min(seg.text.length, end - from)) });
    }
    return toRuby(out);
  });
}

/** Punctuation and spaces never count in a typed answer (as in kanaMatches). */
const LOOSE_TYPED = /[\s、。・,.!?！？「」『』…~〜]/gu;
/** A typed answer for comparing: NFKC, katakana as hiragana, without punctuation or spaces. */
const looseTyped = (s: string) => toHiragana(s.normalize('NFKC')).replace(/-/g, 'ー').replace(LOOSE_TYPED, '');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isKanjiChar = (ch: string) => isKanji(ch) || ch === '々';

/** One stretch of a written form, typed as any of its spellings (a kanji word: as written or as its reading). */
type Piece = readonly string[];

function piecesMatch(input: string, pieces: readonly Piece[]): boolean {
  const pattern = pieces.map((alts) => `(?:${alts.map((a) => escapeRegExp(looseTyped(a))).join('|')})`).join('');
  return new RegExp(`^${pattern}$`, 'u').test(looseTyped(input));
}

/** A plain written form split at its kanji runs, each run paired with the part of `kana` it is read as; null when they don't line up. */
function alignWritten(written: string, kana: string): Piece[] | null {
  const runs = written.match(/[\p{Script=Han}々]+|[^\p{Script=Han}々]+/gu) ?? [];
  const isRun = (run: string) => [...run].every(isKanjiChar);
  const pattern = runs.map((run) => (isRun(run) ? '(.+?)' : escapeRegExp(looseTyped(run)))).join('');
  const found = looseTyped(kana).match(new RegExp(`^${pattern}$`, 'u'));
  if (!found) return null;
  let group = 1;
  return runs.map((run) => (isRun(run) ? [run, found[group++]] : [run]));
}

/**
 * A typed answer with kanji in it (a phone's Japanese keyboard offers them, and KanaInput lets them through) is right
 * when it spells one of the accepted written forms, each kanji word typed as written or as its reading: 疲れたから
 * ちょっと休もう and 疲れたからちょっとやすもう both spell {疲|つか}れたからちょっと{休|やす}もう. A form is ruby markup
 * (each `{kanji|reading}` either way), or plain text aligned with one of its `readings` (each run of kanji either way).
 * Kana-only answers are kanaMatches' job: this returns false for them.
 */
export function writtenMatches(input: string, forms: readonly { written: RubyText; readings?: readonly string[] }[]): boolean {
  if (![...input].some(isKanjiChar)) return false;
  return forms.some(({ written, readings = [] }) => {
    const segs = parseRuby(written);
    if (segs.some((seg) => seg.reading !== undefined)) {
      return piecesMatch(input, segs.map((seg) => (seg.reading === undefined ? [seg.text] : [seg.text, seg.reading])));
    }
    if (![...written].some(isKanjiChar)) return false;
    if (looseTyped(input) === looseTyped(written)) return true;
    return readings.some((reading) => {
      const pieces = alignWritten(written, rubyToPlain(reading));
      return pieces !== null && piecesMatch(input, pieces);
    });
  });
}

/**
 * Readings of the other words written like this one (人: ひと, じん, にん). Shown alone, without a sentence, the written
 * form can be read as any of them, so each is a right reading too (and never a wrong option).
 */
async function homographReadings(word: WordInfo): Promise<string[]> {
  if (!word.kanji.length) return [];
  const [core, words] = await Promise.all([loadCoreWords(), loadWords()]);
  const own = new Set(word.readings.map(toHiragana));
  const others = [
    ...core.filter((c) => c.written === word.written).flatMap((c) => [c.kana, ...(c.altKana ?? [])]),
    ...words.filter((w) => w.written === word.written).flatMap((w) => [w.kana, ...(w.altKana ?? [])]),
  ];
  return [...new Set(others)].filter((r) => !own.has(toHiragana(r)));
}

/** Card content with its options; null when its data is missing. */
export async function prepareCard(card: CardRecord, ctx: PrepareContext): Promise<PreparedCard | null> {
  const random = ctx.random ?? Math.random;
  const key = keyOf(card);
  const item = await db.items.get(card.itemId);
  const base = { card, ...(item?.customMnemonic ? { customMnemonic: item.customMnemonic } : {}) };

  switch (card.kind) {
    case 'kana': {
      const [all, examples] = await Promise.all([loadKana(), loadKanaExamples().catch(() => ({} as Record<string, KanaExample>))]);
      const kana = all.find((k) => k.char === key);
      if (!kana) return null;
      const word = examples[kana.char];
      if (card.type === 'write') {
        const prompt = ctx.inSprint || !word ? 'sound' : 'word';
        // One row-naming rule for the card, the memory pass and the placement check.
        const row = kanaSoundRow(kana, all);
        return {
          ...base, view: 'kana-write', kana, prompt, options: [], answer: kana.char,
          ...(word ? { word } : {}),
          ...(prompt === 'word' && word ? { blanked: blankKana(word.kana, kana.char) } : {}),
          ...(row ? { row } : {}),
        };
      }
      if (ctx.inSprint) {
        // Romaji is only the way to type the sound here: the choices are other kana sounds of the script.
        const peers = all.filter((k) => k.script === kana.script && k.kind === 'basic' && k.char !== kana.char);
        const alsoRight = [...(kana.altRomaji ?? []), ...(PARTICLE_SOUND[kana.char] ? [PARTICLE_SOUND[kana.char]] : [])];
        const twin = SOUND_TWINS[kana.char];
        const exclude = twin ? [...alsoRight, ...(all.find((k) => k.char === twin)?.romaji ?? [])] : alsoRight;
        return {
          ...base, view: 'kana-read', kana, mode: 'romaji', answer: kana.romaji,
          options: options(kana.romaji, [peers.map((k) => k.romaji)], random, exclude),
          ...(word ? { word } : {}),
        };
      }
      // The reading of a kana word is the word itself: choices in kana would only ask to match the same string, and
      // romaji is over with the sprint. So no "Show options" here (§3.2.3: it is a hint, never a giveaway).
      const shown = word?.kana ?? kana.char;
      return { ...base, view: 'kana-read', kana, mode: 'word', answer: shown, options: [], ...(word ? { word } : {}) };
    }

    case 'kanaRule': {
      const rule = (await loadKanaRules()).find((r) => r.id === key);
      if (!rule || !rule.practiceWords.length) return null;
      const wordIndex = card.reps % rule.practiceWords.length;
      const word = rule.practiceWords[wordIndex];
      // As for kana words: the shown kana is its own reading, so kana choices would give it away.
      return { ...base, view: 'kana-rule', rule, word, wordIndex, answer: word.kana, options: [] };
    }

    case 'kanji': {
      const kanji = await loadKanji();
      const entry = kanji[key];
      if (!entry) return null;
      if (card.type === 'meaning') return { ...base, view: 'kanji-meaning', kanji: entry, options: [], answer: entry.meanings[0] };
      const [curriculum, info] = await Promise.all([loadCurriculum(), loadWordInfo()]);
      const anchorRef = curriculum.units.find((u) => u.char === key)?.anchor ?? null;
      const anchor = anchorRef ? info(anchorRef) : undefined;
      if (anchor && anchor.written.includes(key)) {
        return { ...base, view: 'kanji-write', kanji: entry, anchor, blanked: blankKanji(anchor.written, key), reading: anchor.kana, options: [], answer: key };
      }
      return { ...base, view: 'kanji-write', kanji: entry, reading: zeroWordReading(entry), options: [], answer: key };
    }

    case 'word':
    case 'core': {
      const [info, accents] = await Promise.all([loadWordInfo(), loadAccent()]);
      const word = info(card.itemId);
      if (!word) return null;
      const accent = accents[card.itemId];
      const withAccent = accent ? { accent } : {};
      const display = wordDisplay(word, card.kind === 'word' || Boolean(item?.spelledAt));
      if (card.type === 'listen') return { ...base, view: 'listen', word, ...withAccent, display, options: [], answer: word.kana };
      if (card.type === 'produce') {
        return { ...base, view: 'produce', word, ...withAccent, display, answer: word.kana, options: await produceOptions(word, random) };
      }
      // read: the word inside a known carrier phrase when there is one, else alone.
      const carrier = exampleSentenceFor(card.itemId, await loadSentences(), ctx.known);
      const surface = carrier?.tokens.find((t) => t.ref === card.itemId)?.s ?? word.written;
      const cue = (carrier && splitCue(carrier.jp, surface, tokenOffset(carrier.tokens, card.itemId))) || { before: '', target: word.written, after: '' };
      const inCarrier = Boolean(carrier && cue.before + cue.after);
      // Alone, 人 could be ひと, じん or にん: every word written the same way counts (the reveal says which one this is).
      const homographs = inCarrier ? [] : await homographReadings(word);
      const opts = await readingOptions(word.kana, { kanji: word.kanji, written: word.written, exclude: [...word.readings, ...homographs] }, random);
      return {
        ...base, view: 'word-read', word, ...(inCarrier && carrier ? { carrier } : {}), ...withAccent, cue,
        display: wordDisplay(word, true), answer: word.kana, options: opts, homographs,
      };
    }

    case 'grammar': {
      const point = (await loadGrammarIndex()).get(key);
      if (!point) return null;
      if (card.type === 'comprehend') {
        if (!point.examples.length) return null;
        // Examples 0–2 belong to the lesson: the rotation starts after them and never repeats the last two shown.
        const exampleIndex = (3 + card.reps) % point.examples.length;
        return { ...base, view: 'grammar-comprehend', point, example: point.examples[exampleIndex], exampleIndex, options: [], answer: point.examples[exampleIndex].en };
      }
      if (!point.buildItems.length) return null;
      // buildItems[0] is the lesson's build: reviews start with the next one.
      const itemIndex = (1 + card.reps) % point.buildItems.length;
      const item = point.buildItems[itemIndex];
      const tiles = ctx.grammarIntroduced < TYPED_BUILD_FROM;
      const plainJp = parseRuby(item.jp).map((s) => s.text).join('');
      const others = point.buildItems.filter((b) => b !== item).map((b) => parseRuby(b.jp).map((s) => s.text).join(''));
      // Tiles and choices are plain text for checking; these give each one the readings of its kanji for display.
      const tileRuby = piecesRuby(item.jp, item.tiles);
      const rubyOf: Record<string, RubyText> = Object.fromEntries([
        ...point.buildItems.map((b) => [rubyToPlain(b.jp), b.jp] as const),
        ...item.tiles.map((t, i) => [t, tileRuby[i]] as const),
      ]);
      return {
        ...base, view: 'grammar-build', point, item, itemIndex, tiles, shuffledTiles: shuffleTiles(item.tiles, random), rubyOf,
        answer: plainJp, options: tiles ? [] : options(plainJp, [others], random, item.alternatives),
      };
    }

    case 'sentence': {
      const sentence = await db.savedSentences.get(key);
      if (!sentence) return null;
      const cue = splitCue(sentence.jp, sentence.blank.surface);
      if (!cue) return null;
      const reading = sentence.blank.reading;
      const opts = await readingOptions(reading, { written: sentence.blank.surface, exclude: [] }, random);
      return { ...base, view: 'cloze', sentence, cue: { ...cue, target: CLOZE_GAP }, answer: reading, options: opts };
    }
  }
}
