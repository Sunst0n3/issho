// What each new-item lesson shows, loaded from the static data and the learner's progress.

import { db } from '../../../lib/db.ts';
import {
  loadAccent,
  loadAudioManifest,
  loadCurriculum,
  loadGrammarIndex,
  loadKana,
  loadKanaExamples,
  loadKanaRules,
  loadKanji,
  loadMnemonics,
  loadRadicals,
  loadWordInfo,
  type KanaExample,
  type WordInfo,
} from '../../../lib/data.ts';
import { rubyToPlain } from '../../../lib/ruby.ts';
import type {
  AccentInfo,
  ClipAccentPhrase,
  CurriculumUnit,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  MnemonicEntry,
  RubyText,
} from '../../../lib/types.ts';
import type { NewItemPlan } from '../../../srs/course.ts';
import type { IntroduceResult } from '../../../srs/items.ts';
import { clipRef } from '../../../../shared/voicevox.ts';
import { sharedSoundRow } from '../format.ts';
import type { LearnedItem } from '../session/machine.ts';

/** One entry of a kanji's parts panel: a component kanji (its keyword) or a named part (its name). */
export interface PartInfo {
  char: string;
  name: string;
  kind: 'kanji' | 'part';
  /** The learner met it before: an introduced component kanji, or a named part of an earlier lesson's kanji. */
  known: boolean;
}

export type LessonData =
  | { kind: 'kana'; kana: KanaEntry; example?: KanaExample }
  | { kind: 'kanaRule'; rule: KanaRule }
  | {
      kind: 'kanji';
      kanji: KanjiEntry;
      unit?: CurriculumUnit;
      anchor?: WordInfo;
      anchorAccent?: AccentInfo;
      mnemonic?: MnemonicEntry;
      parts: PartInfo[];
      /** Some part is new to the learner: the lesson starts with a trace. */
      newPart: boolean;
    }
  | { kind: 'core'; word: WordInfo; accent?: AccentInfo; display: RubyText }
  | { kind: 'staged'; word: WordInfo; accent?: AccentInfo; upgrade: boolean }
  | { kind: 'grammar'; point: GrammarPoint; examplePitch: (ClipAccentPhrase[] | undefined)[] };

/** The word as ruby markup: `{written|kana}` when it has a kanji spelling the learner can be shown, else kana. */
export function wordRuby(word: Pick<WordInfo, 'written' | 'kana'>, spelled = true): RubyText {
  return spelled && word.written !== word.kana ? `{${word.written}|${word.kana}}` : word.kana;
}

/** Basic kana that sound the same (お and を are both "o"). */
const SOUND_TWINS: Record<string, string> = { お: 'を', を: 'お', オ: 'ヲ', ヲ: 'オ' };

/**
 * The row a sound-only "write the kana you hear" prompt names, as "(わ row)": for a kana with a sound twin (お/を,
 * オ/ヲ) or one whose romaji another basic kana of its script shares. Undefined when the sound alone is enough.
 * The review card's kana-write prompt follows the same rule.
 */
export function kanaSoundRow(kana: KanaEntry, all: readonly KanaEntry[]): string | undefined {
  if (SOUND_TWINS[kana.char]) {
    return all.filter((k) => k.script === kana.script && k.group === kana.group).sort((a, b) => a.order - b.order)[0]?.char;
  }
  return sharedSoundRow(kana, all.filter((k) => k.kind === 'basic'));
}

async function introducedIds(kind: 'kanji'): Promise<Set<string>> {
  return new Set((await db.items.where('kind').equals(kind).primaryKeys()).map((id) => String(id).slice(kind.length + 1)));
}

/**
 * The parts panel of a kanji: its component kanji with their keyword and its named parts with their names, each
 * marked known or new. A named part counts as known once a kanji that has it was introduced. `newPart` decides the
 * trace: some listed part is new, or, for a kanji with no listed parts (日, 一, 人 …), the kanji itself is, since it
 * is its own one part: new until an earlier lesson's kanji had it as a component or a named part.
 */
async function partsOf(kanji: KanjiEntry, all: Record<string, KanjiEntry>): Promise<{ parts: PartInfo[]; newPart: boolean }> {
  const [radicals, introduced] = await Promise.all([loadRadicals(), introducedIds('kanji')]);
  const names = new Map(radicals.map((r) => [r.char, r.name]));
  const earlier = [...introduced].flatMap((c) => (c === kanji.char || !all[c] ? [] : [all[c]]));
  const seenParts = new Set(earlier.flatMap((k) => k.parts));
  const parts = [
    ...kanji.components.map((c): PartInfo => ({ char: c, name: all[c]?.meanings[0] ?? '', kind: 'kanji', known: introduced.has(c) })),
    ...kanji.parts.map((c): PartInfo => ({ char: c, name: names.get(c) ?? '', kind: 'part', known: seenParts.has(c) })),
  ];
  if (parts.length) return { parts, newPart: parts.some((p) => !p.known) };
  const seenWhole = earlier.some((k) => k.components.includes(kanji.char) || k.parts.includes(kanji.char));
  return { parts, newPart: !seenWhole };
}

/** The lesson content for a planned item; null when its data is missing. */
export async function loadLesson(plan: NewItemPlan): Promise<LessonData | null> {
  switch (plan.kind) {
    case 'kana': {
      const [all, examples] = await Promise.all([loadKana(), loadKanaExamples().catch(() => ({} as Record<string, KanaExample>))]);
      const kana = all.find((k) => k.char === plan.key);
      if (!kana) return null;
      const example = examples[kana.char];
      return { kind: 'kana', kana, ...(example ? { example } : {}) };
    }
    case 'kanaRule': {
      const rule = (await loadKanaRules()).find((r) => r.id === plan.key);
      return rule ? { kind: 'kanaRule', rule } : null;
    }
    case 'kanji': {
      const [kanji, curriculum, mnemonics, info, accents] = await Promise.all([
        loadKanji(), loadCurriculum(), loadMnemonics(), loadWordInfo(), loadAccent(),
      ]);
      const entry = kanji[plan.key];
      if (!entry) return null;
      const unit = curriculum.units.find((u) => u.char === plan.key);
      const anchorRef = plan.anchor ?? unit?.anchor ?? null;
      const anchor = anchorRef ? info(anchorRef) : undefined;
      const { parts, newPart } = await partsOf(entry, kanji);
      const mnemonic = mnemonics[plan.key];
      const anchorAccent = anchorRef ? accents[anchorRef] : undefined;
      return {
        kind: 'kanji', kanji: entry, parts, newPart,
        ...(unit ? { unit } : {}), ...(anchor ? { anchor } : {}), ...(anchorAccent ? { anchorAccent } : {}), ...(mnemonic ? { mnemonic } : {}),
      };
    }
    case 'core':
    case 'staged': {
      const [info, accents, introduced] = await Promise.all([loadWordInfo(), loadAccent(), introducedIds('kanji')]);
      const word = info(plan.itemId);
      if (!word) return null;
      const accent = accents[plan.itemId];
      if (plan.kind === 'staged') return { kind: 'staged', word, upgrade: Boolean(plan.upgrade), ...(accent ? { accent } : {}) };
      // A core word is shown in kana until every kanji of its spelling has been taught.
      const spelled = word.kanji.length > 0 && word.kanji.every((c) => introduced.has(c));
      return { kind: 'core', word, display: wordRuby(word, spelled), ...(accent ? { accent } : {}) };
    }
    case 'grammar': {
      const [index, manifest] = await Promise.all([loadGrammarIndex(), loadAudioManifest()]);
      const point = index.get(plan.key);
      if (!point) return null;
      const examplePitch = point.examples.slice(0, 3).map((_, n) => {
        const id = manifest.byRef[clipRef.grammarExample(point.id, n)];
        return id ? manifest.clips[id]?.accentPhrases : undefined;
      });
      return { kind: 'grammar', point, examplePitch };
    }
  }
}

/**
 * What a sitting learned from one introduced plan item: the item ids, its New cards, and the card the memory pass
 * retrieves (kanji/kana write, core produce, else core listen; none for rules, grammar and staged words).
 */
export function learnedItem(plan: NewItemPlan, results: readonly IntroduceResult[]): LearnedItem {
  const cards = results.flatMap((r) => r.cards);
  const fresh = cards.filter((c) => c.reps === 0 && !c.suspended).map((c) => c.id);
  const has = (id: string) => fresh.includes(id);
  let memoryCardId: string | undefined;
  if (plan.kind === 'kanji' || plan.kind === 'kana') memoryCardId = `${plan.itemId}|write`;
  else if (plan.kind === 'core') memoryCardId = has(`${plan.itemId}|produce`) ? `${plan.itemId}|produce` : `${plan.itemId}|listen`;
  return {
    plan,
    itemIds: [...new Set(results.map((r) => r.item.id))],
    cardIds: fresh,
    ...(memoryCardId && has(memoryCardId) ? { memoryCardId } : {}),
  };
}

/** "あ", "あ and い", "あ, い and う". */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Items named per clause of the summary line ("write 我, 義 and 議"). */
const MAX_NAMED = 3;
/** Kana named when there are no practice words to name. */
const MAX_KANA = 5;

interface Clause {
  verb: 'write' | 'read' | 'use' | 'say';
  list: string[];
}

/**
 * The clauses as one phrase: "write 休 and read 休み" when each names one thing, else comma-separated with a final
 * ", and" so a clause's own list stays readable ("write 我 and 義, read 自我, and say がくせい").
 */
function joinClauses(clauses: readonly Clause[]): string {
  const texts = clauses.map((c) => `${c.verb} ${joinAnd(c.list)}`);
  if (texts.length <= 1) return texts[0] ?? '';
  if (texts.length === 2 && clauses.every((c) => c.list.length === 1)) return texts.join(' and ');
  return `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`;
}

/** A gloss that is one quoted phrase loses its quotes ("want to"); a list of them keeps every pair ("and", "with"). */
function unquote(gloss: string): string {
  return /^"[^"]*"$/.test(gloss) ? gloss.slice(1, -1) : gloss;
}

/**
 * A grammar point for the summary line, from its title "<short pattern> — <gloss>": "〜と ("and", "with")",
 * "〜たい (want to)". A title that names the form in English ("Passive — …", "Describing nouns with sentences") gives
 * the pattern and that name: "〜れる・〜られる (passive)".
 */
export function grammarPhrase(point: Pick<GrammarPoint, 'title' | 'pattern'>): string {
  const at = point.title.indexOf(' — ');
  const name = at < 0 ? point.title : point.title.slice(0, at);
  const gloss = at < 0 ? '' : point.title.slice(at + 3);
  if (/[A-Za-z]{2,}/.test(name)) {
    const named = /^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name;
    return `${rubyToPlain(point.pattern)} (${named})`;
  }
  return gloss ? `${rubyToPlain(name)} (${unquote(gloss)})` : rubyToPlain(point.pattern);
}

/**
 * The summary's "You can now …" line from the items introduced today: "write" today's kanji; "read" their anchor
 * words, the staged words released today, then today's kana practice words (or the kana themselves) and a kana
 * rule's practice words; "use" the grammar point; "say" the new core words (not the anchors or staged words, which
 * came with kanji). Up to 3 names per clause: "You can now write 我, 義 and 議, read 自我 and 会議, and say がくせい."
 * Undefined when nothing was introduced.
 */
export async function youCanNow(itemIds: readonly string[], kanaWords: readonly string[] = []): Promise<string | undefined> {
  const byKind = (kind: string) => itemIds.filter((id) => id.startsWith(`${kind}:`)).map((id) => id.slice(kind.length + 1));
  const kanjiChars = byKind('kanji');
  const wordIds = itemIds.filter((id) => id.startsWith('core:') || id.startsWith('word:'));
  const [curriculum, info, wordItems] = kanjiChars.length || wordIds.length
    ? await Promise.all([loadCurriculum(), loadWordInfo(), db.items.bulkGet(wordIds)])
    : [undefined, undefined, []];
  const clauses: Clause[] = [];
  if (kanjiChars.length) clauses.push({ verb: 'write', list: kanjiChars.slice(0, MAX_NAMED) });

  // Words that came with today's kanji: each kanji's anchor (unless it is the kanji alone) and released staged words.
  const anchorOf = (c: string) => curriculum?.units.find((u) => u.char === c)?.anchor ?? null;
  const anchorRefs = new Set<string>(kanjiChars.flatMap((c) => anchorOf(c) ?? []));
  const anchors = kanjiChars.flatMap((c) => {
    const ref = anchorOf(c);
    const w = ref ? info?.(ref) : undefined;
    return w && w.written !== c ? [w.written] : [];
  });
  const stagedRefs = new Set(wordItems.flatMap((item) => (item?.via === 'staged' ? [item.id] : [])));
  const staged = [...stagedRefs].flatMap((ref) => info?.(ref)?.written ?? []);
  const kanaChars = byKind('kana');
  const ruleId = byKind('kanaRule')[0];
  const rule = ruleId ? (await loadKanaRules()).find((r) => r.id === ruleId) : undefined;
  const words = [...new Set([
    ...anchors,
    ...staged,
    ...(kanaChars.length ? kanaWords : []),
    ...(rule?.practiceWords.map((w) => w.kana) ?? []),
  ])];
  const read = words.length ? words.slice(0, MAX_NAMED) : kanaChars.slice(0, MAX_KANA);
  if (read.length) clauses.push({ verb: 'read', list: read });

  const grammarId = byKind('grammar')[0];
  const point = grammarId ? (await loadGrammarIndex()).get(grammarId) : undefined;
  if (point) clauses.push({ verb: 'use', list: [grammarPhrase(point)] });

  const said = itemIds
    .filter((id) => id.startsWith('core:') && !anchorRefs.has(id) && !stagedRefs.has(id))
    .flatMap((id) => info?.(id)?.kana ?? []);
  if (said.length) clauses.push({ verb: 'say', list: said.slice(0, MAX_NAMED) });

  return clauses.length ? `You can now ${joinClauses(clauses)}.` : undefined;
}
