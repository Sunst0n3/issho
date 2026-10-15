// @vitest-environment node
// Sanity checks on the generated public/data files (skipped until `npm run build:data` has
// produced the v2 files), plus the role-play source rule on a fixture.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rubyToPlain } from '../src/lib/ruby.ts';
import type {
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  KanjiEntry,
  MnemonicsFile,
  RadicalEntry,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  StrokesFile,
  UnitSpec,
  WordEntry,
} from '../src/lib/types.ts';
import { mergeContent, readContentSources } from './lib/content.ts';
import { LEAD_MEANINGS } from './lib/kanjidic.ts';
import { buildRolePlays } from './lib/roleplays.ts';

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));
const CONTENT = fileURLToPath(new URL('../content/', import.meta.url));
const read = <T,>(file: string): T => JSON.parse(readFileSync(DATA + file, 'utf8')) as T;
const built =
  existsSync(`${DATA}curriculum.json`) &&
  existsSync(`${DATA}strokes.json`) &&
  existsSync(`${DATA}content/core-words.json`) &&
  read<{ version?: number }>('curriculum.json').version === 2;

describe.skipIf(!built)('generated data', () => {
  let kana: KanaEntry[];
  let kanji: Record<string, KanjiEntry>;
  let radicals: RadicalEntry[];
  let words: WordEntry[];
  let strokes: StrokesFile;
  let curriculum: Curriculum;
  let core: CoreWord[];
  let unitIndex: Map<string, number>;
  let refExists: (ref: string) => boolean;

  beforeAll(() => {
    kana = read<KanaEntry[]>('kana.json');
    kanji = read<Record<string, KanjiEntry>>('kanji.json');
    radicals = read<RadicalEntry[]>('radicals.json');
    words = read<WordEntry[]>('words.json');
    strokes = read<StrokesFile>('strokes.json');
    curriculum = read<Curriculum>('curriculum.json');
    core = read<CoreWord[]>('content/core-words.json');
    unitIndex = new Map(curriculum.units.map((u) => [u.char, u.index]));
    const ids = new Set([...words.map((w) => `word:${w.id}`), ...core.map((c) => `core:${c.id}`)]);
    refExists = (ref) => ids.has(ref);
  });

  it('writes the large files one entry per line (about half of 2-space JSON) and the rest with 2 spaces', () => {
    const lines = (file: string) => readFileSync(DATA + file, 'utf8').split('\n').length;
    expect(lines('words.json')).toBe(words.length + 3);
    expect(lines('strokes.json')).toBe(Object.keys(strokes).length + 3);
    expect(lines('content/stories.json')).toBe(read<unknown[]>('content/stories.json').length + 3);
    expect(readFileSync(`${DATA}curriculum.json`, 'utf8').startsWith('{\n  "version": 2,')).toBe(true);
  });

  it('lists all 208 kana in chart order, the 92 basic ones with their sprint day', () => {
    expect(kana).toHaveLength(208);
    expect(kana.slice(0, 5).map((k) => k.char).join('')).toBe('あいうえお');
    expect(kana.map((k) => k.order)).toEqual(kana.map((_, i) => i));
    const basic = kana.filter((k) => k.sprintDay !== undefined);
    expect(basic).toHaveLength(92);
    expect(basic.every((k) => k.kind === 'basic')).toBe(true);
    const days = (script: string) => [...new Set(basic.filter((k) => k.script === script).map((k) => k.sprintDay))];
    expect(days('hiragana')).toEqual([1, 2, 3, 4, 5]);
    expect(days('katakana')).toEqual([8, 9, 10, 11, 12]);
  });

  it('has stroke data with the right counts, for every kana, kanji and named part', () => {
    expect(strokes['水']).toHaveLength(4);
    expect(strokes['あ']).toHaveLength(3);
    expect(strokes['ア']).toHaveLength(2);
    expect(strokes['語']).toHaveLength(14);
    expect(strokes['水'][0]).toMatch(/^M[\d.]+,[\d.]+/);
    for (const k of kana) if ([...k.char].length === 1) expect(strokes[k.char], k.char).toBeDefined();
    for (const u of curriculum.units) expect(strokes[u.char]?.length, u.char).toBeGreaterThan(0);
    for (const r of radicals) expect(strokes[r.char]?.length, r.char).toBeGreaterThan(0);
  });

  it('is a version 2 curriculum of all 2,136 jōyō kanji, with chapters of 15 and no radical units', () => {
    const { units } = curriculum;
    expect(curriculum.version).toBe(2);
    expect(units).toHaveLength(2136);
    expect(new Set(units.map((u) => u.char)).size).toBe(units.length);
    expect(units.map((u) => u.index)).toEqual(units.map((_, i) => i));
    expect(units.every((u) => u.chapter === Math.floor(u.index / 15) + 1)).toBe(true);
    expect(units.some((u) => radicals.some((r) => r.char === u.char && !kanji[r.char]))).toBe(false);
    expect('phaseEnds' in curriculum).toBe(false);
    expect(Array.isArray(curriculum.confusables)).toBe(true);
  });

  it('resolves every anchor and staged ref, and uses each word in one unit only', () => {
    const refs = curriculum.units.flatMap((u) => [u.anchor, ...u.staged].filter((r) => r !== null));
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(refExists(ref!), ref!).toBe(true);
    for (const u of curriculum.units) {
      expect(u.staged.length).toBeLessThanOrEqual(2);
      if (u.anchor === null) expect(u.staged).toEqual([]);
    }
    const anchorOf = (ch: string) => {
      const ref = curriculum.units[unitIndex.get(ch)!].anchor!;
      return ref.startsWith('core:') ? core.find((c) => `core:${c.id}` === ref)?.written : words.find((w) => `word:${w.id}` === ref)?.written;
    };
    expect(anchorOf('上')).toBe('上');
    expect(anchorOf('見')).toBe('見る');
    expect(anchorOf('人')).toBe('人');
  });

  it('gives kanji.json the rank, components and named parts of every curriculum kanji', () => {
    expect(Object.keys(kanji)).toEqual(curriculum.units.map((u) => u.char));
    for (const u of curriculum.units) expect(kanji[u.char].rank).toBe(u.index + 1);
    expect(kanji['水']).toMatchObject({ char: '水', on: ['スイ'], kun: ['みず'], strokeCount: 4, grade: 1, jlptOld: 4 });
    expect(kanji['水'].meanings[0]).toBe('water');
    expect(kanji['語'].components).toEqual(['言', '五', '口']);
    expect(kanji['海'].parts).toContain('氵');
    expect(kanji['毎'].parts).toEqual(['𠂉', '毋']);
    for (const u of curriculum.units) {
      for (const c of kanji[u.char].components) expect(unitIndex.get(c)!, `${c} in ${u.char}`).toBeLessThan(u.index);
    }
  });

  it('ships a name for every named part, and only the named parts in use', () => {
    const used = new Set(Object.values(kanji).flatMap((k) => k.parts));
    expect(new Set(radicals.map((r) => r.char))).toEqual(used);
    expect(radicals.find((r) => r.char === '氵')).toMatchObject({ name: 'water (side)', variantOf: '水' });
    expect(radicals.find((r) => r.char === '毋')).toMatchObject({ meaning: 'mother', variantOf: '母' });
    for (const r of radicals) expect(r.name && r.meaning, r.char).toBeTruthy();
  });

  it('leads with the everyday meaning and has no numeric or symbolic glosses', () => {
    for (const [char, lead] of Object.entries(LEAD_MEANINGS)) expect(kanji[char].meanings[0], char).toBe(lead);
    expect(kanji['京'].meanings).toEqual(['capital', 'ten quadrillion']);
    for (const k of Object.values(kanji)) {
      expect(k.meanings.length, k.char).toBeGreaterThan(0);
      for (const m of k.meanings) expect(m, k.char).not.toMatch(/\d|[*%&]|\bradical\b/);
      for (const r of k.on) expect(r, `${k.char} on`).toMatch(/^[ァ-ヺー]+$/);
      for (const r of k.kun) expect(r, `${k.char} kun`).toMatch(/^[ぁ-ゖー.]+$/);
    }
  });

  it('has unique, well-formed words with priorities, core links, use and alternate kana', () => {
    const ids = words.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(words.length).toBeGreaterThan(20000);
    const coreIds = new Set(core.map((c) => c.id));
    for (const w of words) {
      expect(w.meanings.length).toBeGreaterThan(0);
      expect(w.meanings.length).toBeLessThanOrEqual(3);
      expect(w.kanji.length).toBeGreaterThan(0);
      for (const ch of w.kanji) expect(kanji[ch], `${ch} in ${w.written}`).toBeDefined();
      expect(w.freqRank >= 1 && w.freqRank <= 49).toBe(true);
      expect(w.pri?.length, w.written).toBeGreaterThan(0);
      if (w.core) expect(coreIds.has(w.core), w.written).toBe(true);
      if (w.use) expect(w.core, w.written).toBeUndefined();
      for (const k of w.altKana ?? []) expect(k).not.toBe(w.kana);
    }
    expect(words.find((w) => w.written === '水' && w.kana === 'みず')?.meanings[0]).toBe('water');
    expect(words.find((w) => w.written === '全然')?.meanings[0]).toBe('not at all');
    expect(words.filter((w) => w.core).length).toBeGreaterThan(900);
  });

  it('publishes core words with kanji, unit and altKana derived', () => {
    const units = read<UnitSpec[]>('content/units.json');
    expect(core.map((c) => c.order)).toEqual(core.map((_, i) => i + 1));
    for (const c of core) {
      expect(c.kanji).toEqual([...new Set([...(c.written ?? '')].filter((ch) => /\p{Script=Han}/u.test(ch) && ch !== '々'))]);
      const expected = units.find((u) => u.coreWordCeiling >= c.order)?.id ?? units[units.length - 1].id;
      expect(c.unit, c.id).toBe(expected);
    }
    expect(core.find((c) => c.written === 'Tシャツ')?.kanji).toEqual([]);
  });

  it('adds script to every kana rule and 10 katakana menu words to kata-extended', () => {
    const rules = read<KanaRule[]>('content/kana-rules.json');
    expect(rules.map((r) => [r.id, r.day, r.script])).toEqual([
      ['hira-dakuten', 6, 'hiragana'],
      ['hira-yoon', 7, 'hiragana'],
      ['kata-dakuten-yoon', 13, 'katakana'],
      ['kata-extended', 14, 'katakana'],
    ]);
    const check = rules.find((r) => r.id === 'kata-extended')!.checkWords!;
    expect(check).toHaveLength(10);
    for (const w of check) {
      expect(w.kana).toMatch(/^[ァ-ヺー]+$/);
      expect(refExists(w.ref), w.ref).toBe(true);
    }
    expect(check[0].kana).toBe('コーヒー');
    expect(rules.filter((r) => r.checkWords)).toHaveLength(1);
  });

  it('gives every grammar point its unit and every build item typed answers', () => {
    const grammar = read<GrammarPoint[]>('content/grammar.json');
    expect(grammar.length).toBeGreaterThanOrEqual(110);
    expect(grammar.map((g) => g.order)).toEqual([...grammar.map((g) => g.order)].sort((a, b) => a - b));
    for (const g of grammar) {
      expect(g.unit, g.id).toBeGreaterThanOrEqual(1);
      for (const b of g.buildItems) {
        expect(b.answers.length, g.id).toBeGreaterThan(0);
        expect(b.answers.length).toBeLessThanOrEqual(16);
        for (const a of b.answers) expect(a, g.id).toMatch(/^[ぁ-ゖー0-9a-zA-Z]+$/);
      }
    }
  });

  it('pre-tokenises every sentence, with refs that resolve and its audio unit', () => {
    const sentences = read<SentenceEntry[]>('content/sentences.json');
    expect(sentences.length).toBeGreaterThanOrEqual(400);
    for (const s of sentences) {
      expect(s.unit, s.id).toBeGreaterThanOrEqual(1);
      expect(s.tokens.map((t) => t.s).join('')).toBe(s.jp.replace(/\{([^{}|]+)\|[^{}|]+\}/g, '$1').replace(/\s/g, ''));
      for (const ref of s.refs) expect(refExists(ref), `${s.id} ${ref}`).toBe(true);
    }
  });

  it('ships stories sorted by level then id, with phrases, characters and refs', () => {
    const stories = read<StoryEntry[]>('content/stories.json');
    const levels = ['start', 'L0', 'L1'];
    const sorted = [...stories].sort((a, b) => levels.indexOf(a.level) - levels.indexOf(b.level) || a.id.localeCompare(b.id));
    expect(stories.map((s) => s.id)).toEqual(sorted.map((s) => s.id));
    for (const s of stories) {
      expect(s.chars).toBeGreaterThan(0);
      for (const sentence of s.sentences) {
        expect(sentence.jp).not.toContain('／');
        expect(sentence.phrases.join('')).toBe(sentence.jp);
        expect(sentence.tokens.every((t) => t.ph !== undefined && t.ph < sentence.phrases.length)).toBe(true);
        // Read-while-listening highlights by `ph`: each phrase holds exactly its own text.
        const byPhrase = sentence.phrases.map((_, n) => sentence.tokens.filter((t) => t.ph === n).map((t) => t.s).join(''));
        expect(byPhrase, `${s.id} ${sentence.jp}`).toEqual(sentence.phrases.map((p) => rubyToPlain(p).replace(/\s/g, '')));
      }
      for (const ref of s.refs) expect(refExists(ref), `${s.id} ${ref}`).toBe(true);
    }
  });

  it('ships units by id with ready flags, role-plays with core conversations first, and normalised mnemonics', () => {
    const units = read<UnitSpec[]>('content/units.json');
    expect(units.map((u) => u.id)).toEqual(units.map((_, i) => i + 1));
    for (const u of units) {
      for (const cd of u.canDos) expect(typeof cd.ready).toBe('boolean');
      expect(typeof u.task.ready).toBe('boolean');
    }
    const rolePlays = read<RolePlay[]>('content/roleplays.json');
    const conversations = units.map((u) => u.conversation);
    expect(rolePlays.slice(0, conversations.length).map((r) => r.id)).toEqual(conversations);
    for (const r of rolePlays) for (const l of r.lines) expect(typeof l.cue).toBe('string');
    const hooks = read<MnemonicsFile>('content/mnemonics.json');
    expect(Object.keys(hooks).length).toBeGreaterThanOrEqual(300);
    for (const h of Object.values(hooks)) expect(typeof h.meaning).toBe('string');
  });

  it('no longer ships v1 survival words', () => {
    expect(existsSync(`${DATA}content/survival-words.json`)).toBe(false);
  });
});

describe('role-play source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issho-roleplays-'));
  const content = join(dir, 'content');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const script = (id: string, title: string) => ({
    id,
    title,
    titleJp: 'カフェ',
    setting: 'A café.',
    level: 1,
    register: 'polite',
    targets: [],
    roles: { a: { name: 'A', nameJp: 'エマ' }, b: { name: 'B', nameJp: 'ケン' } },
    lines: [{ role: 'a', jp: 'こんにちは。', en: 'Hello.', cue: 'hello' }],
  });

  it('publishes the roleplays-v2/ folder when it exists, warning that roleplays-v2.json differs', () => {
    mkdirSync(join(content, 'roleplays-v2'), { recursive: true });
    writeFileSync(join(content, 'roleplays-v2', 'legacy.json'), JSON.stringify([script('rp-cafe', 'Café (edited)')]));
    writeFileSync(join(content, 'roleplays-v2', 'rp-u01.json'), JSON.stringify(script('rp-u01', 'Neighbours')));
    writeFileSync(join(content, 'roleplays-v2.json'), JSON.stringify([script('rp-cafe', 'Café'), script('rp-u01', 'Neighbours')]));
    const set = readContentSources(content, 'roleplays', dir);
    expect(set.warnings).toEqual(['content/roleplays-v2.json is ignored because content/roleplays-v2/ exists; 1 differ (rp-cafe)']);
    const merged = mergeContent('roleplays', set.sources, set.v1);
    expect(merged.errors).toEqual([]);
    const { rolePlays } = buildRolePlays(merged.data as unknown[], {
      grammarOrder: new Map(),
      coreIds: new Set(),
      conversations: new Map([['rp-u01', 1]]),
    });
    expect(rolePlays.map((r) => [r.id, r.title])).toEqual([
      ['rp-u01', 'Neighbours'],
      ['rp-cafe', 'Café (edited)'],
    ]);
  });

  it('fails on the same id in two files of the folder', () => {
    writeFileSync(join(content, 'roleplays-v2', 'rp-u02.json'), JSON.stringify(script('rp-u01', 'Copy')));
    const set = readContentSources(content, 'roleplays', dir);
    expect(mergeContent('roleplays', set.sources).errors).toEqual([
      'content/roleplays-v2/rp-u02.json: id "rp-u01" is also used in content/roleplays-v2/rp-u01.json',
    ]);
  });

  it('upgrades v1 content/roleplays.json only when neither v2 source exists', () => {
    const only = join(dir, 'v1', 'content');
    mkdirSync(only, { recursive: true });
    const { register: _r, targets: _t, ...v1 } = script('rp-old', 'Old');
    writeFileSync(join(only, 'roleplays.json'), JSON.stringify([{ ...v1, lines: [{ role: 'a', jp: 'はい。', en: 'Yes.' }] }]));
    const set = readContentSources(only, 'roleplays', join(dir, 'v1'));
    expect(set.v1).toBe(true);
    const merged = mergeContent('roleplays', set.sources, set.v1);
    expect(merged.errors).toEqual([]);
    const [rp] = buildRolePlays(merged.data as unknown[], { grammarOrder: new Map(), coreIds: new Set(), conversations: new Map() }, true).rolePlays;
    expect(rp).toMatchObject({ register: 'mixed', targets: [], lines: [{ cue: '' }] });
  });

  it('reads the real content from the folder', () => {
    const set = readContentSources(CONTENT, 'roleplays');
    expect(set.label).toBe('content/roleplays-v2');
    expect(set.v1).toBe(false);
  });
});
