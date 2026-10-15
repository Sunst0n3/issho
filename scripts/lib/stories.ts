// Graded stories (content/stories/*.json): structural checks, the level and grammar rules of
// scripts/v2/coverage.ts, and the published StoryEntry (phrases, pre-tokenised sentences, chars,
// refs). See TECH-DESIGN §3.6.1 step 10.

import { validateRuby } from '../../src/lib/ruby.ts';
import type { StoryEntry, StoryLevel, StorySentence } from '../../src/lib/types.ts';
import { COVERAGE_TARGET, STORY_LIMITS } from '../v2/coverage.ts';
import { plainText, type RubyToken } from '../v2/tokenize.ts';
import { Checker, eachObject, isObj, labelOf, type ContentField, type ContentItem, type Obj } from './checker.ts';
import { contentRefs, refCoverage, toPreTokens } from './pretoken.ts';

export const STORY_LEVELS: readonly StoryLevel[] = ['start', 'L0', 'L1'];
export const PHRASE_MARK = '／';
export const GIST_OPTIONS = 3;

/** Structural checks for one story file's data (a StoryEntry or an array of them). */
export function checkStories(data: unknown, c: Checker): ContentItem[] {
  const items: ContentItem[] = [];
  eachObject(Array.isArray(data) ? data : [data], c, 'stories', (s, i) => {
    const id = c.id(s, `[${i}]`);
    const where = labelOf(i, id);
    const fields: ContentField[] = [];
    c.oneOf(s, 'level', where, STORY_LEVELS);
    const unit = c.number(s, 'unit', where);
    if (unit !== undefined && (!Number.isInteger(unit) || unit < 1)) c.error(where, '"unit" must be a unit id');
    c.string(s, 'title', where);
    c.ruby(s, 'titleJp', where, fields);
    c.string(s, 'topic', where);
    c.strings(s, 'grammar', where);
    const sentences = c.array(s, 'sentences', where);
    if (sentences.length === 0) c.error(where, 'has no sentences');
    sentences.forEach((line, j) => {
      const at = `${where}.sentences[${j}]`;
      if (!isObj(line)) return c.error(at, 'must be an object');
      const jp = c.ruby(line, 'jp', at, fields);
      c.string(line, 'en', at);
      if (jp !== undefined && jp.split(PHRASE_MARK).some((p) => !p.trim())) c.error(at, `empty phrase between ${PHRASE_MARK} marks`);
      // Each phrase is published as ruby text of its own, so a mark must not cut a ruby group ({駅／前|えきまえ}).
      else if (jp !== undefined && validateRuby(jp).length === 0 && jp.split(PHRASE_MARK).some((p) => validateRuby(p).length > 0)) {
        c.error(at, `a ${PHRASE_MARK} mark cuts through ruby in "${jp}"`);
      }
    });
    const gist = c.object(s, 'gist', where);
    if (gist) {
      c.string(gist, 'q', `${where}.gist`);
      const options = c.strings(gist, 'options', `${where}.gist`);
      if (options.length !== GIST_OPTIONS) c.error(`${where}.gist`, `needs exactly ${GIST_OPTIONS} options`);
      const answer = gist.answer;
      if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
        c.error(`${where}.gist`, `"answer" ${JSON.stringify(answer)} is not an option index`);
      }
    }
    items.push({ id: id ?? String(i), where, fields });
  });
  return items;
}

/** Characters a reader reads: ruby readings, phrase marks and spaces left out. */
export function storyChars(sentences: readonly { jp: string }[]): number {
  return sentences.reduce((n, s) => n + plainText(s.jp).length, 0);
}

/** The author's phrases of a sentence, split at ／. */
export function splitPhrases(jp: string): string[] {
  return jp.split(PHRASE_MARK).map((p) => p.trim()).filter(Boolean);
}

export interface StoryContext {
  tokenize: (text: string) => RubyToken[];
  links: ReadonlyMap<string, string>;
  /** The written form of a words.json entry (see toPreTokens). */
  writtenOf?: (id: string) => string | undefined;
  grammarOrder: ReadonlyMap<string, number>;
  /** Unit id → its core-word ceiling and the order of its last grammar point. */
  units: ReadonlyMap<number, { coreWordCeiling: number; lastGrammar: number }>;
  coreOrder: ReadonlyMap<string, number>;
}

export interface BuiltStory {
  story: StoryEntry;
  errors: string[];
  warnings: string[];
  /** Coverage at the unit's core-word ceiling (names left out). */
  coverage: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The published StoryEntry of a story that passed checkStories. Errors: an unknown unit (when units
 * exist), an unknown grammar id or one taught after the unit's last point. Warnings: a character count outside the
 * level's range (or too many distinct words for 'start') and coverage under 98 % at the unit's ceiling.
 */
export function buildStory(raw: Obj, ctx: StoryContext): BuiltStory {
  const errors: string[] = [];
  const warnings: string[] = [];
  const id = str(raw.id);
  const level = raw.level as StoryLevel;
  const unitId = Number(raw.unit);
  const unit = ctx.units.get(unitId);
  // Units are optional content: while none are published (the build warns about that), neither a
  // story's unit nor its coverage at the unit's ceiling can be checked, but the story still ships.
  if (!unit && ctx.units.size > 0) errors.push(`${id}: unit ${unitId} does not exist`);
  const grammar = (Array.isArray(raw.grammar) ? raw.grammar : []).filter((g): g is string => typeof g === 'string');
  for (const g of grammar) {
    const order = ctx.grammarOrder.get(g);
    if (order === undefined) errors.push(`${id}: unknown grammar id "${g}"`);
    else if (unit && order > unit.lastGrammar) errors.push(`${id}: grammar "${g}" (#${order}) is taught after unit ${unitId} (last #${unit.lastGrammar})`);
  }

  const sentences: StorySentence[] = (Array.isArray(raw.sentences) ? raw.sentences : []).filter(isObj).map((s) => {
    const jp = str(s.jp);
    return {
      jp: splitPhrases(jp).join(''),
      en: str(s.en),
      tokens: toPreTokens(ctx.tokenize(jp), ctx.links, { phrases: true, writtenOf: ctx.writtenOf }),
      phrases: splitPhrases(jp),
    };
  });
  const tokens = sentences.flatMap((s) => s.tokens);
  const chars = storyChars(sentences);
  const refs = contentRefs(tokens);

  const limits = STORY_LIMITS[level];
  if (limits && (chars < limits.min || chars > limits.max)) {
    warnings.push(`${id}: ${chars} characters, outside ${level}'s ${limits.min}–${limits.max}`);
  }
  if (limits?.maxWords !== undefined && refs.length > limits.maxWords) {
    warnings.push(`${id}: ${refs.length} distinct words, over ${level}'s ${limits.maxWords}`);
  }
  const ceiling = unit?.coreWordCeiling ?? Infinity;
  const coverage = refCoverage(tokens, ctx.coreOrder, ceiling);
  if (unit && coverage.ratio < COVERAGE_TARGET) {
    warnings.push(`${id}: ${(coverage.ratio * 100).toFixed(1)} % of its words are core words up to #${ceiling} (${COVERAGE_TARGET * 100} % expected)`);
  }
  if (!sentences.some((s) => s.phrases.length > 1)) warnings.push(`${id}: no ${PHRASE_MARK} phrase marks (needed for read-while-listening)`);

  const gist = (isObj(raw.gist) ? raw.gist : {}) as Obj;
  const story: StoryEntry = {
    id,
    level,
    unit: unitId,
    title: str(raw.title),
    titleJp: str(raw.titleJp),
    topic: str(raw.topic),
    grammar,
    sentences,
    gist: {
      q: str(gist.q),
      options: (Array.isArray(gist.options) ? gist.options : []).filter((o): o is string => typeof o === 'string'),
      answer: Number(gist.answer),
    },
    chars,
    refs,
  };
  return { story, errors, warnings, coverage: coverage.ratio };
}

/** Stories sorted by level (start, L0, L1), then id. */
export function sortStories(stories: StoryEntry[]): StoryEntry[] {
  const rank = (s: StoryEntry) => STORY_LEVELS.indexOf(s.level);
  return stories.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
