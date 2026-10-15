// The card guard: an AI-corrected sentence becomes a cloze card only when every
// word and every grammar point in it is something the learner was taught. The
// AI's own word list and grammar tags are never trusted on their own: the words
// must cover the sentence exactly, and grammar markers run on the text itself.

import { dayKey, db } from '../lib/db.ts';
import { loadCoreWords, loadWords } from '../lib/data.ts';
import { rubyToPlain } from '../lib/ruby.ts';
import type { AiWord } from '../../shared/api.ts';
import type { SavedSentenceRecord, WordRef } from '../lib/types.ts';
import { daysBetween } from './days.ts';
import { introduceItem } from './items.ts';
import { loadKnownWords, type KnownWords } from './readListen.ts';
import { toHiragana } from './romaji.ts';

export interface GrammarMarker { id: string; pattern: RegExp }

/**
 * ~20 rule-based markers (ids are grammar-v2 ids), run on the plain text. They err toward matching: a false match
 * only means no card for that sentence, while a missed one would put untaught grammar on a card.
 */
export const GRAMMAR_MARKERS: readonly GrammarMarker[] = [
  // Godan passive (書かれる, 言われた) and the ichidan/-ru form られる, which potential shares.
  { id: 'passive', pattern: /[かさたなばまがわ]れ(?:る|ます|ません|ない|なかった|た|て)|られ(?:る|ます|ません|ない|なかった|た|て)/ },
  { id: 'causative', pattern: /(?:[かさたなばまがわ]せ|させ)(?:る|ます|ません|ない|なかった|た|て|られ)/ },
  { id: 'ba-conditional', pattern: /ければ|[けせてねべめれげ]ば(?![かり])/ },
  { id: 'tara-conditional', pattern: /(?<![あは])たら(?![しく])|(?<!あ)だら(?![しけ])/ },
  { id: 'nara', pattern: /(?<!よう)なら(?!ない|なかった|ず|べ|う|っ|い|ん)/ },
  { id: 'temo-even-if', pattern: /(?:(?<!と)て|(?<=[んい])で)も(?!いい|よ[いろ]|かまわ|ら)/ },
  { id: 'sou-looks', pattern: /(?<=[\p{sc=Han}ぁ-ゖ])(?<![るたいだそち])そう(?:だ|です|な|に|[。、！？]|$)/u },
  { id: 'sou-hearsay', pattern: /[るたいだ]そう(?:だ|です)/ },
  { id: 'you-da', pattern: /よう(?:だ|です|な)|ように(?!な)|みたい(?:だ|です|な|に)/ },
  { id: 'te-shimau', pattern: /[てで]しま[うっいわえお]|[ちじ]ゃ[うっいわえお]/ },
  { id: 'te-oku', pattern: /[てで]お[くかきけこい]|っと(?:く[。、ねよ]|いた|いて)|んど(?:く[。、ねよ]|いた|いて)/ },
  { id: 'te-miru', pattern: /[てで]み(?:る|た|ます|まし|ません|て|よう|ない|れば|たら)/ },
  { id: 'nagara', pattern: /ながら/ },
  { id: 'tsumori', pattern: /つもり/ },
  { id: 'kamoshirenai', pattern: /かもしれ|かも(?:ね|よ|[。！？]|$)/ },
  { id: 'nakereba-naranai', pattern: /なければ|なきゃ|なくちゃ|ないといけ/ },
  { id: 'potential-form', pattern: /られ(?:る|ます|ません|ない|なかった|た|て)|これる|こられ/ },
  { id: 'volitional', pattern: /(?<=[\p{sc=Han}ぁ-ゖ])(?<![がだきおはあどそっん])(?:[こそとのぼもろごお]う|よう)(?=[。！？!?]|と(?:思|おも)|か[。？?]|$)/u },
  { id: 'tari-tari', pattern: /[たっだ]り.*[たっだ]り/ },
  { id: 'sugiru', pattern: /すぎ(?:る|た|ます|まし|ません|て|ない)|過ぎ(?:る|た|ます|まし|ません|て|ない)/ },
];

/** Particles, copula and auxiliary forms counted as resolved without a dictionary entry. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // Particles
  'は', 'が', 'を', 'に', 'で', 'と', 'へ', 'も', 'の', 'や', 'か', 'ね', 'よ', 'な', 'わ', 'ぞ', 'さ',
  'から', 'まで', 'より', 'だけ', 'しか', 'って', 'けど', 'けれど', 'けれども', 'ので', 'のに', 'し', 'ほど',
  'など', 'ばかり', 'くらい', 'ぐらい', 'ずつ', 'ごろ', 'でも', 'とか', 'には', 'では', 'とは', 'へは', 'にも',
  'との', 'への', 'からの', 'までの', 'よね', 'かな', 'かね', 'のか', 'んだ', 'んです',
  // Copula and auxiliaries
  'だ', 'です', 'でした', 'だった', 'でしょう', 'だろう', 'じゃない', 'ではない', 'じゃありません', 'ではありません',
  'じゃなかった', 'ではなかった', 'ます', 'ません', 'ました', 'ませんでした', 'ましょう', 'ませんか', 'たい', 'たいです',
  'ない', 'なかった', 'た', 'て', 'ている', 'ています', 'ていた', 'ていました', 'ください', 'でございます',
  // Name suffixes
  'さん', 'ちゃん', 'くん', 'さま', 'たち',
]);

const LONGEST_FUNCTION_WORD = Math.max(...[...FUNCTION_WORDS].map((w) => w.length));
const PUNCTUATION = /[\s、。，．,.!?！？「」『』（）()…・〜~：:；;“”"']/u;

export interface GuardInput { corrected: string; en: string; words: readonly AiWord[]; grammarUsed: readonly string[]; target?: string }
export interface GuardContext {
  /** Resolves a lemma or surface (written or kana) to a core/JMdict ref. */
  lookup(form: string): WordRef | undefined;
  known: KnownWords;
  grammarKnown: ReadonlySet<string>;
  /** Today's day key: prefers a recently introduced word as the blank. */
  today?: string;
}
export interface GuardResult { ok: boolean; reasons: string[]; blank?: SavedSentenceRecord['blank'] }

const normalize = (s: string) => s.normalize('NFKC');

function isFunctionWord(surface: string): boolean {
  return FUNCTION_WORDS.has(normalize(surface));
}

function isPunctuation(surface: string): boolean {
  return [...surface].every((ch) => PUNCTUATION.test(ch));
}

/** The longest function word at `pos`, or 0. */
function functionWordAt(text: string, pos: number): number {
  for (let len = Math.min(LONGEST_FUNCTION_WORD, text.length - pos); len > 0; len--) {
    if (FUNCTION_WORDS.has(text.slice(pos, pos + len))) return len;
  }
  return 0;
}

/** The surfaces, in order, plus punctuation and function words between them, spell the text exactly. */
function coversExactly(text: string, words: readonly AiWord[]): boolean {
  let pos = 0;
  let next = 0;
  while (pos < text.length) {
    const surface = next < words.length ? normalize(words[next].surface) : '';
    if (surface && text.startsWith(surface, pos)) {
      pos += surface.length;
      next++;
      continue;
    }
    if (PUNCTUATION.test(text[pos])) {
      pos++;
      continue;
    }
    const fn = functionWordAt(text, pos);
    if (!fn) return false;
    pos += fn;
  }
  // Trailing entries the text does not contain are words the model invented.
  return words.slice(next).every((w) => isPunctuation(w.surface) || !normalize(w.surface));
}

/** The grammar markers that match the text. */
export function grammarMarkersIn(text: string): string[] {
  return GRAMMAR_MARKERS.filter((m) => m.pattern.test(text)).map((m) => m.id);
}

/**
 * pure. The AI's word list is never trusted on its own. ok only when all of these hold:
 *  1. Coverage: the AiWord surfaces, in order, plus punctuation/spaces and FUNCTION_WORDS between them, concatenate
 *     exactly to rubyPlain(corrected) (NFKC). A token the model left out of `words` fails this check.
 *  2. Dictionary: every content surface resolves through lookup(surface) or lookup(lemma) to a core/JMdict ref
 *     (or is a FUNCTION_WORDS entry), and that ref is introduced.
 *  3. Grammar: GRAMMAR_MARKERS are run on `corrected` itself, independently of the AI; every match must be introduced.
 *  4. grammarUsed is only an extra fail signal: any id not introduced, or 'other', fails; it can never make a sentence pass.
 * blank = the target word when present, else the first known content word introduced in the last 21 days, else the
 * first known word.
 */
export function guardSentence(input: GuardInput, ctx: GuardContext): GuardResult {
  const reasons: string[] = [];
  const text = normalize(rubyToPlain(input.corrected)).trim();
  if (!text) reasons.push('empty sentence');

  if (!coversExactly(text, input.words)) reasons.push('the word list does not cover the sentence');

  const content: { word: AiWord; ref: WordRef }[] = [];
  for (const word of input.words) {
    if (isPunctuation(word.surface) || isFunctionWord(word.surface)) continue;
    const ref = ctx.lookup(normalize(word.surface)) ?? ctx.lookup(normalize(word.lemma));
    if (!ref) {
      reasons.push(`unknown word: ${word.surface}`);
      continue;
    }
    if (ctx.known.introducedDay(ref) === undefined) {
      reasons.push(`not introduced: ${word.surface}`);
      continue;
    }
    content.push({ word, ref });
  }

  for (const id of grammarMarkersIn(text)) {
    if (!ctx.grammarKnown.has(id)) reasons.push(`grammar not introduced: ${id}`);
  }
  for (const id of input.grammarUsed) {
    if (id === 'other' || !ctx.grammarKnown.has(id)) reasons.push(`grammar not introduced: ${id}`);
  }

  if (reasons.length) return { ok: false, reasons };

  const recent = (ref: WordRef) => {
    const day = ctx.known.introducedDay(ref);
    return ctx.today !== undefined && day !== undefined && daysBetween(day, ctx.today) <= 21;
  };
  const chosen =
    (input.target ? content.find((c) => c.ref === input.target || normalize(c.word.surface) === normalize(input.target!)) : undefined) ??
    content.find((c) => ctx.known.isKnown(c.ref) && recent(c.ref)) ??
    content.find((c) => ctx.known.isKnown(c.ref)) ??
    content[0];
  if (!chosen) return { ok: false, reasons: ['no word to blank'] };
  return {
    ok: true,
    reasons: [],
    blank: { surface: chosen.word.surface, reading: toHiragana(chosen.word.reading), ref: chosen.ref },
  };
}

let lookupIndex: Promise<(form: string) => WordRef | undefined> | undefined;

/** Written forms and readings of every core and JMdict word → ref (a core word's identity wins). */
export function loadWordLookup(): Promise<(form: string) => WordRef | undefined> {
  lookupIndex ??= Promise.all([loadCoreWords(), loadWords()]).then(([cores, words]) => {
    const index = new Map<string, WordRef>();
    const add = (form: string | undefined, ref: WordRef) => {
      if (form && !index.has(normalize(form))) index.set(normalize(form), ref);
    };
    for (const c of cores) add(c.written, `core:${c.id}`);
    for (const w of words) add(w.written, w.core ? `core:${w.core}` : `word:${w.id}`);
    for (const c of cores) add(c.kana, `core:${c.id}`);
    for (const w of words) add(w.kana, w.core ? `core:${w.core}` : `word:${w.id}`);
    return (form: string) => index.get(normalize(form)) ?? index.get(toHiragana(normalize(form)));
  });
  lookupIndex.catch(() => (lookupIndex = undefined));
  return lookupIndex;
}

async function grammarIntroduced(): Promise<Set<string>> {
  const keys = await db.items.where('kind').equals('grammar').primaryKeys();
  return new Set(keys.map((k) => String(k).slice('grammar:'.length)));
}

/** Guard + SavedSentenceRecord + introduce 'sentence' item (cloze). Uncorrected learner text never becomes a card. */
export async function createGuardedCloze(input: GuardInput, source: 'correction' | 'recap', now: Date = new Date()): Promise<string | null> {
  const [lookup, known, grammarKnown] = await Promise.all([loadWordLookup(), loadKnownWords(now), grammarIntroduced()]);
  const result = guardSentence(input, { lookup, known, grammarKnown, today: dayKey(now) });
  if (!result.ok || !result.blank) return null;
  const blank = result.blank;
  return db.transaction('rw', db.savedSentences, db.items, db.cards, async () => {
    const existing = (await db.savedSentences.toArray()).find((s) => s.jp === input.corrected);
    const id = existing?.id ?? `custom-${crypto.randomUUID()}`;
    if (!existing) {
      await db.savedSentences.add({ id, jp: input.corrected, en: input.en, savedAt: now, source, blank });
    }
    const { cards } = await introduceItem('sentence', id, now, { via: 'saved' });
    return cards[0]?.id ?? null;
  });
}
