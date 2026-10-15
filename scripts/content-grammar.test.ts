// @vitest-environment node
// Checks for grammar-v2 (content/grammar-v2.json, or its part files) and the typed answers of
// its build items (scripts/lib/answers.ts). The checks against the curriculum need public/data
// (npm run build:data) and skip without it.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isKanaOnly, kanjiIn, rubyToKana, rubyToPlain } from '../src/lib/ruby.ts';
import type { Curriculum, GrammarPoint } from '../src/lib/types.ts';
import { MAX_ANSWERS, buildAnswers, normalizeAnswer, tokenAnswers } from './lib/answers.ts';
import {
  DRILL_BLANK,
  MIN_BUILD_ITEMS,
  MIN_GRAMMAR_EXAMPLES,
  MIN_GRAMMAR_POINTS,
  PLAIN_FORM_MAX_ORDER,
  PLAIN_FORM_POINTS,
  checkContent,
  checkGrammarSet,
  itemKanji,
  latePlainForms,
  mergeContent,
  readContentSources,
} from './lib/content.ts';
import { getTokenizer, type RubyTokenizer } from './v2/tokenize.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const built = existsSync(`${ROOT}public/data/curriculum.json`) && read<{ version?: number }>('public/data/curriculum.json').version === 2;

const source = readContentSources(`${ROOT}content`, 'grammar', ROOT);
const merged = mergeContent('grammar', source.sources);
const points = merged.data as GrammarPoint[];
const order = new Map(points.map((p) => [p.id, p.order]));

describe('content grammar-v2', () => {
  it('passes the shared content validator with no errors', () => {
    expect(source.errors).toEqual([]);
    expect(merged.errors).toEqual([]);
    expect(checkGrammarSet(points as never[]).errors).toEqual([]);
  });

  it(`has at least ${MIN_GRAMMAR_POINTS} points, running 1..n with unique kebab-case ids`, () => {
    expect(points.length).toBeGreaterThanOrEqual(MIN_GRAMMAR_POINTS);
    points.forEach((p, i) => {
      expect(p.order, p.id).toBe(i + 1);
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });
    expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
  });

  it(`gives every point ≥ ${MIN_GRAMMAR_EXAMPLES} examples and ≥ ${MIN_BUILD_ITEMS} build items unless recognition-only`, () => {
    for (const p of points) {
      expect(p.examples.length, p.id).toBeGreaterThanOrEqual(MIN_GRAMMAR_EXAMPLES);
      if (p.recognitionOnly) expect(p.buildItems, p.id).toEqual([]);
      else expect(p.buildItems.length, p.id).toBeGreaterThanOrEqual(MIN_BUILD_ITEMS);
    }
    expect(points.filter((p) => p.recognitionOnly).map((p) => p.id).sort()).toEqual(['causative', 'keigo-set-phrases', 'keigo-verbs', 'passive']);
  });

  it('builds every tile set back into the plain sentence', () => {
    for (const p of points) for (const b of p.buildItems) expect(b.tiles.join(''), p.id).toBe(rubyToPlain(b.jp));
  });

  it('lists prerequisites that come earlier, and contrasts that exist', () => {
    for (const p of points) {
      for (const q of p.prerequisites) expect(order.get(q)!, `${p.id} needs ${q}`).toBeLessThan(p.order);
      for (const q of p.contrastWith) expect(order.has(q), `${p.id} contrasts ${q}`).toBe(true);
    }
  });

  it('gives every drill one blank outside ruby, 3–4 distinct kana options and an English line', () => {
    for (const p of points) {
      for (const d of p.drills) {
        expect(d.prompt.split(DRILL_BLANK), d.prompt).toHaveLength(2);
        expect(d.prompt, 'blank inside ruby').not.toMatch(/\{[^}]*＿/);
        expect(d.options.length, d.prompt).toBeGreaterThanOrEqual(3);
        expect(d.options.length, d.prompt).toBeLessThanOrEqual(4);
        expect(new Set(d.options).size, d.prompt).toBe(d.options.length);
        for (const o of d.options) expect(isKanaOnly(o), `option "${o}"`).toBe(true);
        expect(Number.isInteger(d.answer) && d.answer >= 0 && d.answer < d.options.length, d.prompt).toBe(true);
        expect(d.en.trim(), d.prompt).not.toBe('');
      }
      const answers = new Set(p.drills.map((d) => d.options[d.answer]));
      expect(answers.size, `${p.id}: every drill is ${[...answers].join('')}`).toBeGreaterThan(1);
    }
  });

  it('keeps kanji out of explanations (plain strings cannot show readings)', () => {
    for (const p of points) expect(kanjiIn(p.explanation), p.id).toEqual([]);
  });

  it('reports the plain forms the plan wants by order 22 (kept as authored, lead decision)', () => {
    for (const id of PLAIN_FORM_POINTS) expect(order.has(id), id).toBe(true);
    // An info line in the build, not a warning: exactly the plain-form points after #22, in order.
    const expected = PLAIN_FORM_POINTS.filter((id) => order.get(id)! > PLAIN_FORM_MAX_ORDER).sort((a, b) => order.get(a)! - order.get(b)!);
    expect(latePlainForms(points).map((p) => p.id)).toEqual(expected);
    const fixture = [
      { id: 'casual-past', order: 44 },
      { id: 'dictionary-form', order: 22 },
      { id: 'nai-form', order: 30 },
      { id: 'te-form', order: 40 },
    ];
    expect(latePlainForms(fixture)).toEqual([{ id: 'nai-form', order: 30 }, { id: 'casual-past', order: 44 }]);
  });
  // Lead decision: the plain forms keep their authored order (#29–#44); the build prints the info line above.
});

/**
 * Kana words in examples and build items that are not core words, reported to the lead (content
 * authors' file): もちかえり (JMdict only), チョコ (the core word is チョコレート), どんなに (どんな + に).
 * Remove an entry once the example or the core list is fixed.
 */
const KNOWN_NON_CORE = new Set(['keigo-set-phrases: もちかえり', 'kureru: チョコ', 'temo-even-if: どんなに']);

describe('grammar example vocabulary', () => {
  let tk: RubyTokenizer;
  beforeAll(async () => {
    tk = await getTokenizer();
  }, 30_000);
  const texts = (p: GrammarPoint) => [...p.examples.map((e) => e.jp), ...p.buildItems.map((b) => b.jp)];

  // Every kanji has furigana: validateRuby (in the content validator above) reports a kanji without a reading.
  it('uses core words, or words written in kanji with furigana, in examples and build items (names excepted)', () => {
    const problems = new Set<string>();
    for (const p of points) {
      for (const t of texts(p)) {
        for (const tok of tk.tokenize(t)) {
          if (tok.kind !== 'content' || tok.proper || tok.ref?.startsWith('core:') || kanjiIn(tok.surface).length > 0) continue;
          problems.add(`${p.id}: ${tok.surface}`);
        }
      }
    }
    expect([...problems].filter((x) => !KNOWN_NON_CORE.has(x))).toEqual([]);
  });
});

describe('typed answers for build items', () => {
  let tk: RubyTokenizer;
  beforeAll(async () => {
    tk = await getTokenizer();
  }, 30_000);
  const answers = (jp: string, alternatives: string[] = []) =>
    buildAnswers({ jp, alternatives }, (t) => tk.tokenize(t), rubyToKana);

  it('reads the sentence and its alternatives as hiragana without punctuation', () => {
    const { answers: list, unread } = answers('{今|いま}{何時|なんじ}ですか。', ['今、何時？', 'いまなんじ']);
    expect(list).toEqual(['いまなんじですか', 'いまなんじ']);
    expect(unread).toEqual([]);
  });

  it('also accepts は, へ and を typed as わ, え and お', () => {
    const { answers: list } = answers('わたしは{駅|えき}へ{行|い}きます。');
    expect(list).toEqual(['わたしはえきへいきます', 'わたしはえきえいきます', 'わたしわえきへいきます', 'わたしわえきえいきます']);
    expect(answers('ケーキを{食|た}べた。').answers).toContain('けーきおたべた');
    // こんにちは is one word, not a particle.
    expect(answers('こんにちは。').answers).toEqual(['こんにちは']);
  });

  it('leaves out an alternative it cannot read, and keeps at most 16', () => {
    expect(tokenAnswers([{ surface: '囧', reading: '囧', pos: '名詞' }])).toBeUndefined();
    const many = answers('わたしは{駅|えき}へ{行|い}きます。', ['あなたは駅へ行きます。', 'かれは駅へ行きます。', 'かのじょは駅へ行きます。', 'ともだちは駅へ行きます。']);
    expect(many.answers.length).toBe(MAX_ANSWERS);
    expect(many.answers.slice(0, 5)).toEqual([
      'わたしはえきへいきます',
      'あなたはえきへいきます',
      'かれはえきへいきます',
      'かのじょはえきへいきます',
      'ともだちはえきへいきます',
    ]);
    expect(normalizeAnswer('コーヒー、ください！')).toBe('こーひーください');
  });

  it('adds no answers for an alternative written with digits (10分 is じゅっぷん, which its tokens do not say)', () => {
    const { answers: list, unread } = answers('{午後|ごご}{四時|よじ}{十分|じゅっぷん}です。', ['午後4時10分です。', 'ごご よじ じゅっぷん です']);
    expect(list).toEqual(['ごごよじじゅっぷんです']);
    expect(unread).toEqual([]);
  });

  it.runIf(built)('are published with every build item, the particle variants included', () => {
    const published = read<GrammarPoint[]>('public/data/content/grammar.json');
    const first = published.find((p) => p.id === 'wa-desu')!.buildItems[0];
    expect(first.answers[0]).toBe(normalizeAnswer(rubyToKana(first.jp)));
    expect(first.answers.some((a) => a.includes('わ'))).toBe(true);
    for (const p of published) for (const b of p.buildItems) expect(b.answers, p.id).toContain(normalizeAnswer(rubyToKana(b.jp)));
    for (const p of published) for (const b of p.buildItems) for (const a of b.answers) expect(a, p.id).not.toMatch(/[0-9A-Za-z]/);
  });
});

describe.skipIf(!built)('grammar-v2 against the curriculum', () => {
  it('uses only kanji the curriculum teaches, each with a reading', () => {
    const taught = new Set(read<Curriculum>('public/data/curriculum.json').units.map((u) => u.char));
    for (const item of checkContent('grammar', points).items) {
      expect(itemKanji(item).filter((k) => !taught.has(k)), item.id).toEqual([]);
    }
  });

  it('gives every point the unit that teaches it', () => {
    const published = read<GrammarPoint[]>('public/data/content/grammar.json');
    const units = read<{ id: number; grammar: string[] }[]>('public/data/content/units.json');
    for (const p of published) expect(units.find((u) => u.grammar.includes(p.id))?.id, p.id).toBe(p.unit);
  });
});
