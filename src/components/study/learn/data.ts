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
import { grammarGloss } from '../format.ts';
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

async function introducedIds(kind: 'kanji'): Promise<Set<string>> {
  return new Set((await db.items.where('kind').equals(kind).primaryKeys()).map((id) => String(id).slice(kind.length + 1)));
}

/**
 * The parts panel of a kanji: its component kanji with their keyword and its named parts with their names, each
 * marked known or new. A named part counts as known once a kanji that has it was introduced.
 */
async function partsOf(kanji: KanjiEntry, all: Record<string, KanjiEntry>): Promise<PartInfo[]> {
  const [radicals, introduced] = await Promise.all([loadRadicals(), introducedIds('kanji')]);
  const names = new Map(radicals.map((r) => [r.char, r.name]));
  const seenParts = new Set([...introduced].flatMap((c) => (c === kanji.char ? [] : (all[c]?.parts ?? []))));
  return [
    ...kanji.components.map((c): PartInfo => ({ char: c, name: all[c]?.meanings[0] ?? '', kind: 'kanji', known: introduced.has(c) })),
    ...kanji.parts.map((c): PartInfo => ({ char: c, name: names.get(c) ?? '', kind: 'part', known: seenParts.has(c) })),
  ];
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
      const parts = await partsOf(entry, kanji);
      const mnemonic = mnemonics[plan.key];
      const anchorAccent = anchorRef ? accents[anchorRef] : undefined;
      return {
        kind: 'kanji', kanji: entry, parts, newPart: parts.some((p) => !p.known),
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

/** "read あかい and かお" / "write 休 and read 休み" style phrases joined into one line. */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const MAX_NAMED = 2;

/**
 * The summary's "You can now …" line from what was introduced today: kanji first ("write 休 and read 休み"), then
 * grammar ("use 〜たい: want to"), then kana (read two of today's practice words, or the kana themselves), then core
 * words ("say ありがとう"). Undefined when nothing was introduced.
 */
export async function youCanNow(itemIds: readonly string[], kanaWords: readonly string[] = []): Promise<string | undefined> {
  const byKind = (kind: string) => itemIds.filter((id) => id.startsWith(`${kind}:`)).map((id) => id.slice(kind.length + 1));
  const clauses: string[] = [];
  const kanjiChars = byKind('kanji');
  if (kanjiChars.length) {
    const [curriculum, info] = await Promise.all([loadCurriculum(), loadWordInfo()]);
    const named = kanjiChars.slice(0, MAX_NAMED);
    const anchors = named.flatMap((c) => {
      const ref = curriculum.units.find((u) => u.char === c)?.anchor;
      const w = ref ? info(ref) : undefined;
      return w && w.written !== c ? [w.written] : [];
    });
    clauses.push(`write ${joinAnd(named)}${anchors.length ? ` and read ${joinAnd(anchors)}` : ''}`);
  }
  const grammarIds = byKind('grammar');
  if (grammarIds.length) {
    const index = await loadGrammarIndex();
    const point = index.get(grammarIds[0]);
    if (point) clauses.push(`use ${rubyToPlain(point.pattern)} (${grammarGloss(point).replace(/^"|"$/g, '')})`);
  }
  const kanaChars = byKind('kana');
  if (kanaChars.length && clauses.length < 2) {
    clauses.push(kanaWords.length ? `read ${joinAnd(kanaWords.slice(0, MAX_NAMED))}` : `read ${joinAnd(kanaChars.slice(0, 5))}`);
  }
  const rules = byKind('kanaRule');
  if (rules.length && clauses.length < 2) {
    const rule = (await loadKanaRules()).find((r) => r.id === rules[0]);
    if (rule) clauses.push(`read ${joinAnd(rule.practiceWords.slice(0, MAX_NAMED).map((w) => w.kana))}`);
  }
  const cores = byKind('core');
  if (cores.length && clauses.length < 2) {
    const info = await loadWordInfo();
    const words = cores.slice(0, MAX_NAMED).flatMap((id) => info(`core:${id}`)?.kana ?? []);
    if (words.length) clauses.push(`say ${joinAnd(words)}`);
  }
  return clauses.length ? `You can now ${joinAnd(clauses)}.` : undefined;
}
