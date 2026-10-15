// @vitest-environment node
// Memory hooks: content/mnemonics.json (kanji) and the kana picture hooks in
// content/kana-examples.json, with the lint of scripts/lib/mnemonics.ts (a warning in the build,
// hard here since the mnemonic refresh landed, TECH-DESIGN §6.1 step 1d). The checks against the
// curriculum need public/data (npm run build:data) and skip without it.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Curriculum, KanjiEntry, MnemonicsFile, RadicalEntry } from '../src/lib/types.ts';
import { checkContent, kanaCourse } from './lib/content.ts';
import {
  HOOKED_RANK,
  MAX_HOOK_WORDS,
  MAX_KANA_HOOK_WORDS,
  hookContext,
  isOneSentence,
  lintKanaHooks,
  lintMnemonics,
  normalizeMnemonics,
  wordCount,
} from './lib/mnemonics.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const hooks = read<Record<string, unknown>>('content/mnemonics.json');
const built =
  existsSync(`${ROOT}public/data/content/mnemonics.json`) &&
  existsSync(`${ROOT}public/data/curriculum.json`) &&
  read<{ version?: number }>('public/data/curriculum.json').version === 2;

describe('content/mnemonics.json', () => {
  it('validates cleanly in the old (string) or the new ({ meaning, sound? }) shape', () => {
    const report = checkContent('mnemonics', hooks);
    expect(report.errors).toEqual([]);
  });

  it('keeps every hook plain English on one line', () => {
    for (const [char, { meaning, sound }] of Object.entries(normalizeMnemonics(hooks))) {
      for (const text of [meaning, sound ?? '']) {
        expect(text, `${char}: line break`).not.toMatch(/\n/);
        expect(text, `${char}: Japanese in the hook`).not.toMatch(/[　-ヿ㐀-鿿豈-﫿⺀-⿟]/u);
      }
      expect(meaning.length, char).toBeGreaterThan(0);
    }
  });

  it.runIf(built)('is published normalised to { meaning, sound? }', () => {
    expect(read<MnemonicsFile>('public/data/content/mnemonics.json')).toEqual(normalizeMnemonics(hooks));
  });

  it(`gives all 92 basic kana a one-line picture hook of ≤ ${MAX_KANA_HOOK_WORDS} words`, () => {
    const examples = read<Record<string, { hook?: string }>>('content/kana-examples.json');
    const basic = [...kanaCourse().values()].filter((k) => k.kind === 'basic').map((k) => k.char);
    expect(basic).toHaveLength(92);
    expect(lintKanaHooks(examples, basic)).toEqual([]);
  });
});

describe.skipIf(!built)('content/mnemonics.json against the curriculum', () => {
  const lint = () => {
    const { units } = read<Curriculum>('public/data/curriculum.json');
    const kanji = read<Record<string, KanjiEntry>>('public/data/kanji.json');
    const parts = read<RadicalEntry[]>('public/data/radicals.json');
    return lintMnemonics(normalizeMnemonics(hooks), hookContext(units, kanji, parts));
  };

  it(`gives every curriculum kanji of rank ≤ ${HOOKED_RANK} a meaning hook and a sound hook`, () => {
    expect(lint().filter((p) => p.includes('have no'))).toEqual([]);
  });

  it(`keeps every meaning hook to exactly one sentence of ≤ ${MAX_HOOK_WORDS} words that names only its own parts`, () => {
    expect(lint().filter((p) => !p.includes('have no'))).toEqual([]);
  });
});

describe('hook lint', () => {
  const ctx = {
    rank: new Map([
      ['休', 1],
      ['木', 2],
      ['日', 3],
    ]),
    partsOf: (ch: string) => (ch === '休' ? ['木', '亻'] : []),
    partNames: new Map<string, string[]>([
      ['tree', ['木']],
      ['person', ['亻', '人']],
      ['roof', ['宀']],
      ['one', ['一']],
    ]),
  };

  it('normalises v1 strings to { meaning }', () => {
    expect(normalizeMnemonics({ 水: ' Drops. ', 火: { meaning: 'Sparks.', sound: 'Hi!' } })).toEqual({
      水: { meaning: 'Drops.' },
      火: { meaning: 'Sparks.', sound: 'Hi!' },
    });
  });

  it('counts sentences and words', () => {
    expect(isOneSentence('A person rests against a tree.')).toBe(true);
    expect(isOneSentence('"Stop," he said, "rest here."')).toBe(true);
    expect(isOneSentence('A sun. One day.')).toBe(false);
    expect(isOneSentence('No full stop')).toBe(false);
    expect(wordCount('A person — rests against a tree.')).toBe(6);
  });

  it('wants meaning and sound hooks up to rank 500, one short sentence, naming only the own parts', () => {
    const problems = lintMnemonics(
      {
        休: { meaning: 'A person leans on a tree to rest.', sound: 'Yasu!' },
        木: { meaning: 'A tree under a roof. It grows.' },
      },
      ctx,
    );
    expect(problems).toEqual([
      '1 kanji of rank ≤ 500 have no meaning hook: 日',
      '2 kanji of rank ≤ 500 have no sound hook: 木日',
      '木: the meaning hook must be exactly one sentence: "A tree under a roof. It grows."',
      '木: the meaning hook names "roof" (宀), which is not one of its parts',
    ]);
  });

  it('never counts plain English ("one", "inside") as a part name', () => {
    expect(lintMnemonics({ 休: { meaning: 'One person rests by one tree.', sound: 'x' } }, ctx, 1)).toEqual([]);
  });

  it("lets a hook say the kanji's own meanings, and the words of its own two-word names", () => {
    const own = {
      rank: new Map([['田', 1], ['西', 2]]),
      partsOf: () => [],
      meaningsOf: (ch: string) => (ch === '田' ? ['rice field', 'rice paddy'] : ch === '西' ? ['west', 'Spain'] : []),
      partNames: new Map<string, string[]>([
        ['rice', ['米']],
        ['west', ['襾']],
        ['field', ['里']],
      ]),
    };
    expect(lintMnemonics({ 田: { meaning: 'A rice field cut into four plots.', sound: 'x' }, 西: { meaning: 'The sun sets in the west.', sound: 'x' } }, own)).toEqual([]);
    // "rice" alone is still another kanji's keyword.
    expect(lintMnemonics({ 田: { meaning: 'Rice grows in four plots.', sound: 'x' } }, own, 1)).toEqual([
      '田: the meaning hook names "rice" (米), which is not one of its parts',
    ]);
  });

  it('wants a one-line hook of ≤ 12 words for every basic kana', () => {
    expect(
      lintKanaHooks({ あ: { hook: 'An apple with a stem.' }, い: { hook: 'Two eels swimming side by side in the river under the moon tonight.' } }, ['あ', 'い', 'う']),
    ).toEqual(['1 basic kana have no picture hook: う', 'い: the hook has 13 words (at most 12)']);
  });
});
