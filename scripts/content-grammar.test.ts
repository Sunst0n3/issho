// @vitest-environment node
// Regression checks for content/grammar.json, from the grammar review. The
// curriculum checks need public/data (npm run build:data) and skip without it.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isKanaOnly, kanjiIn, parseRuby, rubyToPlain, type RubySegment } from '../src/lib/ruby.ts';
import type { Curriculum, GrammarDrill, GrammarPoint, WordEntry } from '../src/lib/types.ts';
import { DRILL_BLANK, checkContent, itemKanji, readingMismatches } from './lib/content.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const built = existsSync(`${ROOT}public/data/curriculum.json`) && existsSync(`${ROOT}public/data/words.json`);

const points = read<GrammarPoint[]>('content/grammar.json');
const rubyFields = (p: GrammarPoint) => [p.pattern, ...p.examples.map((e) => e.jp), ...p.drills.map((d) => d.prompt)];
const fill = (d: GrammarDrill, option: string) => d.prompt.replace(DRILL_BLANK, option);
const KATAKANA_RE = /[ァ-ヺー]/;

describe('content/grammar.json', () => {
  it('passes the shared content validator with no errors or warnings', () => {
    const report = checkContent('grammar', points);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('runs 1..n in order with unique kebab-case ids, never going back a phase', () => {
    points.forEach((p, i) => {
      expect(p.order, p.id).toBe(i + 1);
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      if (i > 0) expect(p.phase, `${p.id} goes back a phase`).toBeGreaterThanOrEqual(points[i - 1].phase);
    });
    expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
  });

  it('gives every drill one blank outside ruby, 3–4 distinct kana options and an English line', () => {
    for (const p of points) {
      expect(p.examples.length, p.id).toBeGreaterThanOrEqual(3);
      expect(p.drills.length, p.id).toBeGreaterThanOrEqual(4);
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
    }
  });

  it('keeps phase 1 in hiragana, so it can be read before katakana is taught', () => {
    for (const p of points.filter((x) => x.phase === 1)) {
      for (const s of [...rubyFields(p), ...p.drills.flatMap((d) => d.options), p.title, p.explanation]) {
        expect(kanjiIn(s), `${p.id}: kanji in "${s}"`).toEqual([]);
        expect(rubyToPlain(s), `${p.id}: katakana`).not.toMatch(KATAKANA_RE);
      }
    }
  });

  it('keeps kanji out of titles and explanations (plain strings cannot show readings)', () => {
    for (const p of points) {
      expect(kanjiIn(p.title), p.id).toEqual([]);
      expect(kanjiIn(p.explanation), p.id).toEqual([]);
    }
  });

  it('does not make claims later points contradict', () => {
    // と also follows whole sentences in とおもう (and the conditional と).
    if (points.some((p) => rubyToPlain(p.pattern).includes('と思う'))) {
      for (const p of points) expect(p.explanation, p.id).not.toMatch(/never whole sentences/);
    }
  });
});

describe.skipIf(!built)('content/grammar.json against the curriculum', () => {
  it('uses only kanji the curriculum teaches', () => {
    const taught = new Set(read<Curriculum>('public/data/curriculum.json').units.map((u) => u.char));
    for (const item of checkContent('grammar', points).items) {
      expect(itemKanji(item).filter((k) => !taught.has(k)), item.id).toEqual([]);
    }
  });

  it('reads whole words as words.json does', () => {
    const byWritten = new Map<string, string[]>();
    for (const w of read<WordEntry[]>('public/data/words.json')) {
      byWritten.set(w.written, [...(byWritten.get(w.written) ?? []), w.kana]);
    }
    // Single-kanji bases are mostly verb and adjective stems ({行|い}く) that
    // would be compared with unrelated one-kanji words (行 ぎょう).
    const mismatches = checkContent('grammar', points)
      .items.flatMap((item) => readingMismatches(item, byWritten))
      .filter((m) => [...m.written].length > 1);
    expect(mismatches).toEqual([]);
  });
});

/** Readings that depend on what follows the ruby group. */
const CONTEXT_READINGS: { base: string; reading: string; wrongBefore: RegExp; why: string }[] = [
  { base: '何', reading: 'なに', wrongBefore: /^(の|だ|です)/, why: '何 before の/だ/です is なん' },
  { base: '何', reading: 'なん', wrongBefore: /^(を|が|も|か|\{|$)/, why: '何 before を/が/も/か or a verb is なに' },
  { base: '一日', reading: 'ついたち', wrongBefore: /^/, why: 'ついたち only after a month (一月一日)' },
  { base: '今日', reading: 'こんにち', wrongBefore: /^/, why: '今日 is きょう outside こんにちは' },
];

/** Completions a native speaker would accept for a drill's English; a distractor must never produce one. */
const ACCEPTABLE_COMPLETIONS: { pattern: RegExp; why: string }[] = [
  { pattern: /【[へに]】(行|帰|来)/, why: 'に and へ both mark a destination with 行く/帰る/来る' },
  { pattern: /【[にへ]】ようこそ/, why: 'にようこそ and へようこそ are both fine' },
  { pattern: /[ァ-ヺー]+【に】[ァ-ヺー]+を/, why: 'AにB lists items to order ("coffee with cake")' },
  { pattern: /と.+、【(いつ|どれ)】が/, why: 'いつ/どれ can ask which of a listed set' },
  { pattern: /【[へに]】(話|言)/, why: 'に/へ mark who you speak to' },
  { pattern: /(来|食べ|見|寝|起き|着|出)【?れ】?(る|ます|ない)/, why: 'ra-nuki potential (来れる) is common speech' },
  { pattern: /【おおきな】|大き【な】/, why: 'おおきな is a valid pre-noun form' },
  { pattern: /な【?く(ちゃ|ては)/, why: 'なくちゃ/なくては also mean "have to"' },
];

describe('grammar.json wording', () => {
  it('uses context-dependent readings (何 なに/なん, 一日, 今日) that fit their sentence', () => {
    const markup = (s: RubySegment) => (s.reading === undefined ? s.text : `{${s.text}|${s.reading}}`);
    const problems: string[] = [];
    for (const p of points) {
      for (const text of [...rubyFields(p), ...p.drills.map((d) => fill(d, d.options[d.answer]))]) {
        const segments = parseRuby(text);
        segments.forEach((seg, i) => {
          const after = segments.slice(i + 1).map(markup).join('');
          for (const rule of CONTEXT_READINGS) {
            if (seg.text !== rule.base || seg.reading !== rule.reading) continue;
            if (rule.base === '一日' && segments[i - 1]?.text.endsWith('月')) continue;
            if (rule.wrongBefore.test(after)) problems.push(`${p.id}: ${rule.why} in "${text}"`);
          }
        });
      }
    }
    expect(problems).toEqual([]);
  });

  it('has no distractor that completes a drill the way a native speaker would accept', () => {
    const problems: string[] = [];
    for (const p of points) {
      for (const d of p.drills) {
        d.options.forEach((o, k) => {
          if (k === d.answer) return;
          const filled = rubyToPlain(fill(d, `【${o}】`));
          for (const { pattern, why } of ACCEPTABLE_COMPLETIONS) {
            if (pattern.test(filled)) problems.push(`${p.id}: distractor "${o}" gives "${filled}": ${why} (${d.en})`);
          }
        });
      }
    }
    expect(problems).toEqual([]);
  });
});
