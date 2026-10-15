// @vitest-environment node
// Graded stories (content/stories/*.json): structure, level vs length, words and coverage at the
// unit's core-word ceiling, built the way build-data publishes them (scripts/lib/stories.ts).
// JMdict refs need public/data/words.json (npm run build:data).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoreWord, StoryEntry, UnitSpec, WordEntry } from '../src/lib/types.ts';
import { checkContent, mergeContent, readContentSources } from './lib/content.ts';
import { refCoverage } from './lib/pretoken.ts';
import { buildStory, splitPhrases, storyChars, type BuiltStory } from './lib/stories.ts';
import { COVERAGE_TARGET, STORY_LIMITS } from './v2/coverage.ts';
import { loadTokenizer } from './v2/tokenize.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const content = (kind: Parameters<typeof readContentSources>[1]) => {
  const set = readContentSources(`${ROOT}content`, kind, ROOT);
  return { set, ...mergeContent(kind, set.sources) };
};
const wordsPath = `${ROOT}public/data/words.json`;
const hasWords = existsSync(wordsPath);

const stories = content('stories');
const core = content('core-words').data as CoreWord[];
const units = content('units').data as UnitSpec[];
const grammar = content('grammar').data as { id: string; order: number }[];

describe('content stories', () => {
  let built: BuiltStory[] = [];
  beforeAll(async () => {
    const words = hasWords ? (JSON.parse(readFileSync(wordsPath, 'utf8')) as WordEntry[]) : null;
    const links = new Map((words ?? []).flatMap((w) => (w.core ? [[w.id, w.core] as const] : [])));
    const written = new Map((words ?? []).map((w) => [w.id, w.written]));
    const tk = await loadTokenizer({ core, words });
    const grammarOrder = new Map(grammar.map((g) => [g.id, g.order]));
    const unitInfo = new Map(
      units.map((u) => [u.id, { coreWordCeiling: u.coreWordCeiling, lastGrammar: Math.max(...u.grammar.map((g) => grammarOrder.get(g) ?? 0)) }]),
    );
    built = (stories.data as Record<string, unknown>[]).map((raw) =>
      buildStory(raw, {
        tokenize: (t) => tk.tokenize(t),
        links,
        writtenOf: (id) => written.get(id),
        grammarOrder,
        units: unitInfo,
        coreOrder: new Map(core.map((c) => [c.id, c.order])),
      }),
    );
  }, 60_000);

  it('validate with no errors: structure, ruby, unit and grammar taught by the unit', () => {
    expect(stories.set.errors).toEqual([]);
    expect(stories.errors).toEqual([]);
    expect(built.flatMap((b) => b.errors)).toEqual([]);
    expect(built.length).toBeGreaterThanOrEqual(60);
  });

  it("match their level's length (start 100–300 characters and ≤ 200 words, L0 200–400, L1 400–1,200)", () => {
    for (const { story } of built) {
      const limits = STORY_LIMITS[story.level];
      expect(story.chars, story.id).toBeGreaterThanOrEqual(limits.min);
      expect(story.chars, story.id).toBeLessThanOrEqual(limits.max);
      if (limits.maxWords) expect(story.refs.length, story.id).toBeLessThanOrEqual(limits.maxWords);
    }
  });

  it('mark phrases with ／ and have one gist question with 3 options', () => {
    for (const { story } of built) {
      expect(story.sentences.some((s) => s.phrases.length > 1), story.id).toBe(true);
      expect(story.gist.options, story.id).toHaveLength(3);
    }
  });

  it.runIf(hasWords)('resolve every content word to a core or JMdict word, or mark it as a name', () => {
    const unknown = built.flatMap(({ story }) =>
      story.sentences.flatMap((s) => s.tokens.filter((t) => t.k === 'c' && !t.name && !t.ref).map((t) => `${story.id}: ${t.s}`)),
    );
    expect(unknown).toEqual([]);
  });

  it.runIf(hasWords)(`cover ≥ ${COVERAGE_TARGET * 100} % of their words with core words up to the unit's ceiling`, () => {
    const coreOrder = new Map(core.map((c) => [c.id, c.order]));
    const low = built
      .filter(({ story }) => {
        const ceiling = units.find((u) => u.id === story.unit)!.coreWordCeiling;
        return refCoverage(story.sentences.flatMap((s) => s.tokens), coreOrder, ceiling).ratio < COVERAGE_TARGET;
      })
      .map(({ story }) => story.id);
    expect(low).toEqual([]);
  });
});

describe('story helpers', () => {
  it('split phrases at ／ and count the characters a reader reads', () => {
    expect(splitPhrases('きのう／{駅|えき}の／{近|ちか}くで')).toEqual(['きのう', '{駅|えき}の', '{近|ちか}くで']);
    expect(storyChars([{ jp: 'きのう／{駅|えき}の　ちかくで。' }])).toBe(10);
  });

  it('reject an empty phrase and a phrase mark that cuts through ruby', () => {
    const story = (jp: string) => [{
      id: 'st-l0-99', level: 'L0', unit: 1, title: 'T', titleJp: 'T', topic: 'x', grammar: [],
      sentences: [{ jp, en: 'x' }], gist: { q: 'q', options: ['a', 'b', 'c'], answer: 0 },
    }];
    expect(checkContent('stories', story('{駅|えき}の／{前|まえ}で。')).errors).toEqual([]);
    expect(checkContent('stories', story('{駅／前|えきまえ}で。')).errors).toEqual([
      '[0] st-l0-99.sentences[0]: a ／ mark cuts through ruby in "{駅／前|えきまえ}で。"',
    ]);
    expect(checkContent('stories', story('きのう／／ラーメン。')).errors).toEqual(['[0] st-l0-99.sentences[0]: empty phrase between ／ marks']);
  });

  it('publish a story with phrases, phrase-numbered tokens, characters and refs', async () => {
    const tk = await loadTokenizer({ core, words: null });
    const raw = {
      id: 'st-l0-99', level: 'L0', unit: 1, title: 'T', titleJp: 'T', topic: 'x', grammar: ['wa-desu'],
      sentences: [{ jp: 'わたしは／エマです。', en: "I'm Emma." }],
      gist: { q: 'q', options: ['a', 'b', 'c'], answer: 0 },
    };
    const { story, errors, warnings } = buildStory(raw, {
      tokenize: (t) => tk.tokenize(t),
      links: new Map(),
      grammarOrder: new Map([['wa-desu', 1]]),
      units: new Map([[1, { coreWordCeiling: 200, lastGrammar: 6 }]]),
      coreOrder: new Map(core.map((c) => [c.id, c.order])),
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual(['st-l0-99: 9 characters, outside L0\'s 200–400']);
    const sentence = story.sentences[0] as StoryEntry['sentences'][number];
    expect(sentence).toMatchObject({ jp: 'わたしはエマです。', phrases: ['わたしは', 'エマです。'] });
    expect(sentence.tokens.map((t) => [t.s, t.ph])).toEqual([['わたし', 0], ['は', 0], ['エマ', 1], ['です', 1], ['。', 1]]);
    expect(story.chars).toBe(9);
    expect(story.refs).toHaveLength(1);

    // An unknown unit fails, unless no units are published at all (optional content never fails the build).
    const ctx = { tokenize: (t: string) => tk.tokenize(t), links: new Map<string, string>(), grammarOrder: new Map([['wa-desu', 1]]), coreOrder: new Map<string, number>() };
    const lost = { ...raw, unit: 7 };
    expect(buildStory(lost, { ...ctx, units: new Map([[1, { coreWordCeiling: 200, lastGrammar: 6 }]]) }).errors).toEqual(['st-l0-99: unit 7 does not exist']);
    expect(buildStory(lost, { ...ctx, units: new Map() }).errors).toEqual([]);
  }, 30_000);
});
