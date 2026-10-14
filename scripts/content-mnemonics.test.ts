// @vitest-environment node
// Regression checks for content/mnemonics.json, from the mnemonics review:
// one hook per curriculum unit from the start up to the last hooked unit, in
// teaching order. Needs public/data (npm run build:data); skips without it.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Curriculum, CurriculumUnit, KanjiEntry, RadicalEntry } from '../src/lib/types.ts';
import { checkContent } from './lib/content.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(ROOT + path, 'utf8')) as T;
const built = existsSync(`${ROOT}public/data/curriculum.json`) && existsSync(`${ROOT}public/data/kanji.json`);

const hooks = read<Record<string, string>>('content/mnemonics.json');
const MAX_LENGTH = 140;

describe('content/mnemonics.json', () => {
  it('validates cleanly', () => {
    const report = checkContent('mnemonics', hooks);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it(`keeps each hook to one plain-English line of at most ${MAX_LENGTH} characters`, () => {
    for (const [char, hook] of Object.entries(hooks)) {
      expect(hook, `${char}: surrounding whitespace`).toBe(hook.trim());
      expect(hook.length, char).toBeGreaterThan(0);
      expect(hook.length, char).toBeLessThanOrEqual(MAX_LENGTH);
      expect(hook, `${char}: Japanese in the hook`).not.toMatch(/[　-ヿ㐀-鿿豈-﫿⺀-⿟]/u);
    }
  });
});

describe.skipIf(!built)('content/mnemonics.json against the curriculum', () => {
  const { units } = built ? read<Curriculum>('public/data/curriculum.json') : { units: [] as CurriculumUnit[] };
  const kanji = built ? read<Record<string, KanjiEntry>>('public/data/kanji.json') : {};
  const radicals = new Map(read<RadicalEntry[]>('content/radicals.json').map((r) => [r.char, r]));
  const keys = Object.keys(hooks);
  const lastHooked = Math.max(...keys.map((ch) => units.find((u) => u.char === ch)?.index ?? Infinity));
  const hooked = units.filter((u) => u.index <= lastHooked);

  it('hooks every unit up to the last hooked one, in teaching order', () => {
    expect(keys).toEqual(hooked.map((u) => u.char));
  });

  it('only compares a shape ("Like X …") with elements taught by then', () => {
    // Lower-cased element names (kanji meanings, radical names) → the first unit teaching one.
    const firstTaught = new Map<string, CurriculumUnit>();
    for (const u of units) {
      const r = radicals.get(u.char);
      const names = r ? [r.name.replace(/\s*\(.*\)$/, ''), r.meaning] : (kanji[u.char]?.meanings ?? []);
      for (const name of names) if (!firstTaught.has(name.toLowerCase())) firstTaught.set(name.toLowerCase(), u);
    }
    for (const u of hooked) {
      const named = u.char in hooks ? /^(?:Looks )?like (?:an? )?([a-z]+)/i.exec(hooks[u.char])?.[1].toLowerCase() : undefined;
      const taught = named ? firstTaught.get(named) : undefined;
      if (!taught) continue;
      expect(
        taught.index,
        `${u.char} (#${u.index}) is compared with "${named}" (${taught.char}), only taught at #${taught.index}`,
      ).toBeLessThanOrEqual(u.index);
    }
  });
});
