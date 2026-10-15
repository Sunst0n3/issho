// @vitest-environment node
// Word identity (TECH-DESIGN §3.6.3): a word that is both a JMdict entry and a core word is one
// item, core:<id>, everywhere. Fixtures first, then the built public/data when it exists.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoreWord, Curriculum, SentenceEntry, StoryEntry, WordEntry } from '../src/lib/types.ts';
import { canonicalRef, linkCoreWords, wordRef, type IdentityCore, type IdentityEntry } from './lib/identity.ts';
import { contentRefs, toPreTokens } from './lib/pretoken.ts';
import { loadTokenizer } from './v2/tokenize.ts';

const entry = (id: string, written: string, kana: string): IdentityEntry => ({
  id,
  written,
  kana,
  kanji: [...written].filter((ch) => /\p{Script=Han}/u.test(ch)),
});
const core = (id: string, order: number, kana: string, written?: string, jmdict?: string): IdentityCore => ({ id, order, kana, written, jmdict });

describe('linkCoreWords', () => {
  const entries = [
    entry('1260720', '元気', 'げんき'),
    entry('1404975', '早い', 'はやい'),
    entry('1579840', '十', 'じゅう'),
    entry('1463770', '日', 'ひ'),
    entry('2083100', '日', 'にち'),
    entry('1269320', '後', 'あと'),
    entry('1000580', '彼処', 'あそこ'),
    entry('1999999', 'パン屋', 'パンや'),
  ];

  it('links by JMdict id, by spelling and reading, and a kana-only word to its usual kanji entry', () => {
    const links = linkCoreWords(
      [
        core('cw-0012', 12, 'げんき', '元気', '1260720'),
        core('cw-0474', 474, 'にち', '日', '2083100'),
        core('cw-0752', 752, 'パンや', 'パン屋'),
        core('cw-0300', 300, 'あと', undefined, '1269320'),
        core('cw-0100', 100, 'あそこ'),
      ],
      entries,
      (kana) => (kana === 'あそこ' ? '1000580' : undefined),
    );
    expect(Object.fromEntries(links)).toEqual({
      '1260720': 'cw-0012',
      '2083100': 'cw-0474',
      '1999999': 'cw-0752',
      '1269320': 'cw-0300',
      '1000580': 'cw-0100',
    });
    // 日 ひ is another word than the core 日 にち.
    expect(links.has('1463770')).toBe(false);
  });

  it('gives an entry named by two core words to the one spelled like it, else the lower order', () => {
    const links = linkCoreWords(
      [core('cw-0929', 929, 'はやい', '速い', '1404975'), core('cw-0183', 183, 'はやい', '早い', '1404975')],
      entries,
    );
    expect(links.get('1404975')).toBe('cw-0183');
    const tens = linkCoreWords([core('cw-0331', 331, 'とお', '十', '1579840'), core('cw-0128', 128, 'じゅう', '十', '1579840')], entries);
    expect(tens.get('1579840')).toBe('cw-0128');
  });

  it('writes refs as core:<id> for linked entries and leaves the rest', () => {
    const links = new Map([['1260720', 'cw-0012']]);
    expect(wordRef('1260720', links)).toBe('core:cw-0012');
    expect(wordRef('1463770', links)).toBe('word:1463770');
    expect(canonicalRef('word:1260720', links)).toBe('core:cw-0012');
    expect(canonicalRef('core:cw-0001', links)).toBe('core:cw-0001');
    expect(canonicalRef('grammar:wa-desu', links)).toBe('grammar:wa-desu');
  });
});

const DATA = fileURLToPath(new URL('../public/data/', import.meta.url));
const read = <T,>(file: string): T => JSON.parse(readFileSync(DATA + file, 'utf8')) as T;
const built = existsSync(`${DATA}content/core-words.json`) && existsSync(`${DATA}curriculum.json`) && read<{ version?: number }>('curriculum.json').version === 2;

describe.skipIf(!built)('word identity in public/data', () => {
  const words = built ? read<WordEntry[]>('words.json') : [];
  const coreWords = built ? read<CoreWord[]>('content/core-words.json') : [];
  const curriculum = built ? read<Curriculum>('curriculum.json') : ({ units: [] } as unknown as Curriculum);
  const links = new Map(words.flatMap((w) => (w.core ? [[w.id, w.core] as const] : [])));
  const genki = coreWords.find((c) => c.written === '元気')!;
  const genkiEntry = words.find((w) => w.written === '元気' && w.kana === 'げんき')!;

  it('makes 元気 (a core word with a JMdict id) one item, core:<id>, in words.json and the curriculum', () => {
    expect(genki.jmdict).toBe(genkiEntry.id);
    expect(genkiEntry.core).toBe(genki.id);
    const refs = curriculum.units.flatMap((u) => [u.anchor, ...u.staged]);
    expect(refs).toContain(`core:${genki.id}`);
    expect(refs).not.toContain(`word:${genkiEntry.id}`);
  });

  it('never publishes a word: ref for an entry that is a core word', () => {
    const sentences = read<SentenceEntry[]>('content/sentences.json');
    const stories = read<StoryEntry[]>('content/stories.json');
    const refs = [
      ...curriculum.units.flatMap((u) => [u.anchor, ...u.staged]),
      ...sentences.flatMap((s) => [...s.refs, ...s.tokens.map((t) => t.ref)]),
      ...stories.flatMap((s) => [...s.refs, ...s.sentences.flatMap((x) => x.tokens.map((t) => t.ref))]),
    ];
    const linked = refs.filter((r) => r?.startsWith('word:') && links.has(r.slice(5)));
    expect(linked).toEqual([]);
  });

  it('tokenizes 元気 to core:<id>, whether the tokenizer finds the core word or the JMdict entry', async () => {
    const tk = await loadTokenizer({ core: coreWords, words });
    const tokens = toPreTokens(tk.tokenize('{元気|げんき}ですか。'), links);
    expect(contentRefs(tokens)).toEqual([`core:${genki.id}`]);
    const viaJmdict = toPreTokens([{ surface: '元気', reading: 'げんき', lemma: '元気', pos: '名詞', kind: 'content', phrase: 0, ref: `word:${genkiEntry.id}` }], links);
    expect(viaJmdict[0].ref).toBe(`core:${genki.id}`);
  }, 30_000);
});
