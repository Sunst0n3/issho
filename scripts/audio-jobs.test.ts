// @vitest-environment node
// The audio generator without an engine: jobs, hashes, packs and the manifest (scripts/audio/jobs.ts), and the run
// (scripts/audio/run.ts) against a fake engine that answers with queries recorded from the local VOICEVOX engine.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KanaExamplesFile } from '../src/lib/data.ts';
import type { AudioManifest, CoreWord, GrammarPoint, KanaRule, StoryEntry, UnitSpec } from '../src/lib/types.ts';
import { clipTextKey, splitMoras, toKatakana, type VvQuery } from '../shared/voicevox.ts';
import type { Engine } from './audio/engine.ts';
import {
  buildJobs,
  buildManifest,
  clipFile,
  clipId,
  formatJsonLines,
  formatRecordLines,
  pitchJobFor,
  refKind,
  sampleJobs,
  type AudioJob,
  type AudioSources,
} from './audio/jobs.ts';
import { runJobs, type ClipStore } from './audio/run.ts';
import { buildKanaTable } from './lib/kana.ts';

// ---------------------------------------------------------------------------
// Fixtures

const recorded: Record<string, VvQuery> = {};
for (const name of ['hashi', 'ame', 'hitoke', 'readings']) {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/voicevox/${name}.json`, import.meta.url), 'utf8')) as {
    queries: Record<string, VvQuery>;
  };
  Object.assign(recorded, f.queries);
}
const storyFixture = JSON.parse(readFileSync(new URL('./fixtures/voicevox/sentence-story.json', import.meta.url), 'utf8')) as {
  text: string;
  phrases: string[];
  query: VvQuery;
};
recorded[storyFixture.text] = storyFixture.query;

const kanaExamples = JSON.parse(readFileSync(new URL('../content/kana-examples.json', import.meta.url), 'utf8')) as KanaExamplesFile;

const KANA_ONLY = /^[ぁ-ゖァ-ヺー、。？！\s]+$/u;

/** Queries: recorded ones first; kana text reads as itself; anything else is misread as アア. */
function fakeQuery(text: string): VvQuery {
  if (recorded[text]) return structuredClone(recorded[text]);
  const moras = KANA_ONLY.test(text) ? splitMoras(toKatakana(text).replace(/[、。？！\s]/gu, '')) : ['ア', 'ア'];
  return {
    accent_phrases: [{
      moras: moras.map((m) => ({ text: m, consonant: null, consonant_length: null, vowel: 'a', vowel_length: 0.1, pitch: 5 })),
      accent: 1,
      pause_mora: null,
    }],
    speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
    prePhonemeLength: 0.1, postPhonemeLength: 0.1, outputSamplingRate: 24000, outputStereo: false,
  };
}

/** A 16-bit mono 24 kHz WAV of `ms` milliseconds of silence. */
function wav(ms: number): Uint8Array {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, samples * 2, true);
  return new Uint8Array(buf);
}

class FakeEngine implements Engine {
  queries: { text: string; speaker: number }[] = [];
  syntheses: { moras: string; speaker: number }[] = [];
  async query(text: string, speaker: number): Promise<VvQuery> {
    this.queries.push({ text, speaker });
    return fakeQuery(text);
  }
  async synthesize(q: VvQuery, speaker: number): Promise<Uint8Array> {
    this.syntheses.push({ moras: q.accent_phrases.map((p) => p.moras.map((m) => m.text).join('')).join(''), speaker });
    return wav(100 * q.accent_phrases.reduce((n, p) => n + p.moras.length, 0) + 200);
  }
}

class MemoryStore implements ClipStore {
  files = new Map<string, number>();
  has(file: string) {
    return this.files.has(file);
  }
  async put(file: string, data: Uint8Array) {
    const size = Math.round(data.byteLength / 10);
    this.files.set(file, size);
    return size;
  }
}

const core = (id: string, order: number, kana: string, written: string | undefined, pos: CoreWord['pos'], unit: number): CoreWord => ({
  id, order, kana, written, en: id, pos, register: 'both', topic: 'misc', use: false, kanji: [], unit,
});

const grammar = (id: string, unit: number): GrammarPoint => ({
  id, order: unit, level: 'N5', title: id, pattern: '', register: 'polite', prerequisites: [], contrastWith: [],
  explanation: '', unit, drills: [],
  examples: [{ jp: '{雨|あめ}です。', en: 'Rain.' }, { jp: 'はい。', en: 'Yes.' }],
  buildItems: [{ en: 'Bridge.', jp: '{橋|はし}です。', tiles: ['橋', 'です。'], alternatives: [], answers: ['はしです'] }],
});

const story: StoryEntry = {
  id: 'st-l0-01', level: 'L0', unit: 5, title: 'Morning', titleJp: '{朝|あさ}', topic: 'daily', grammar: [], chars: 0, refs: [],
  gist: { q: '?', options: ['a', 'b', 'c'], answer: 0 },
  sentences: [{ jp: '{私|わたし}は、{毎朝|まいあさ}コーヒーを{飲|の}みます。', en: 'I drink coffee every morning.', tokens: [], phrases: storyFixture.phrases }],
};

const unit: UnitSpec = {
  id: 2, title: 'Unit 2', titleJp: '', level: 'A1', topic: 'x', grammar: [], coreWordCeiling: 100, conversation: 'rp-u02',
  capstone: { title: '', brief: '', minLinesEach: 2, structures: [] },
  canDos: [
    { id: 'u02-cd1', text: '', ready: true, check: { kind: 'listen', instructions: '', material: 'はい、そうです。', questions: [] } },
    { id: 'u02-cd2', text: '', ready: true, check: { kind: 'read', instructions: '', material: 'メニュー', questions: [] } },
    { id: 'u02-cd3', text: '', ready: false, check: { kind: 'listen', instructions: '', material: '', questions: [] } },
  ],
  task: {
    id: 'u02-task', canDo: 'u02-cd1', goal: '', outcomeQuestion: '', roles: { a: 'A', b: 'B' }, infoA: '', infoB: '',
    targets: [], register: 'polite', twist: '', ready: true,
    scripted: [{ role: 'a', jp: 'はい。', en: 'Yes.' }, { role: 'b', jp: 'いいえ。', en: 'No.' }],
  },
};

function sources(): AudioSources {
  return {
    kana: buildKanaTable(),
    kanaExamples,
    kanaRules: [{
      id: 'hira-dakuten', day: 6, script: 'hiragana', title: '', explanation: '', pairs: [],
      practiceWords: [{ kana: 'かぎ', en: 'key' }, { kana: 'ごみ', en: 'trash' }],
    }],
    coreWords: [
      core('cw-0002', 2, 'はし', '橋', 'noun', 1),
      core('cw-0001', 1, 'ありがとう', undefined, 'expression', 1),
      core('cw-0003', 3, 'ひとけ', '人気', 'noun', 3),
      core('cw-0004', 4, 'たべる', '食べる', 'verb-ru', 4),
    ],
    words: [
      { id: '100', written: '箸', kana: 'はし', meanings: ['chopsticks'], pos: ['n'], freqRank: 10, kanji: ['箸'] },
      { id: '101', written: '端', kana: 'はし', meanings: ['edge'], pos: ['n'], freqRank: 10, kanji: ['端'] },
      { id: '102', written: '雨', kana: 'あめ', meanings: ['rain'], pos: ['n'], freqRank: 5, kanji: ['雨'] },
      { id: '103', written: '橋', kana: 'はし', meanings: ['bridge'], pos: ['n'], freqRank: 5, kanji: ['橋'] },
    ],
    curriculum: {
      version: 2,
      confusables: [],
      units: [
        { index: 0, char: '箸', anchor: 'word:100', staged: ['core:cw-0002'], inferable: false, chapter: 1 },
        { index: 1, char: '雨', anchor: 'word:102', staged: ['word:103'], inferable: false, chapter: 2 },
        { index: 2, char: '端', anchor: 'word:101', staged: [], inferable: false, chapter: 2 },
      ],
    },
    grammar: [grammar('desu', 3)],
    sentences: [
      { id: 's-1', jp: '{人気|ひとけ}がない。', en: 'Deserted.', grammar: [], tokens: [], refs: [], unit: 4 },
      { id: 's-2', jp: 'はい。', en: 'Yes.', grammar: [], tokens: [], refs: [], unit: 1 },
    ],
    stories: [story],
    rolePlays: [
      {
        id: 'rp-u02', unit: 2, title: '', titleJp: '', setting: '', level: 1, register: 'polite', targets: [],
        roles: { a: { name: 'A', nameJp: 'A' }, b: { name: 'B', nameJp: 'B' } },
        lines: [{ role: 'a', jp: 'はい。', en: 'Yes.', cue: '' }, { role: 'b', jp: 'いいえ。', en: 'No.', cue: '' }],
      },
      {
        id: 'rp-free', title: '', titleJp: '', setting: '', level: 1, register: 'mixed', targets: [],
        roles: { a: { name: 'A', nameJp: 'A' }, b: { name: 'B', nameJp: 'B' } },
        lines: [{ role: 'b', jp: 'ええ。', en: 'Yeah.', cue: '' }],
      },
    ],
    units: [unit],
  };
}

const byRef = (jobs: AudioJob[]) => new Map(jobs.map((j) => [j.ref, j]));

async function run(jobs: AudioJob[], previous: AudioManifest | null = null, store = new MemoryStore(), cache = {}) {
  const engine = new FakeEngine();
  const result = await runJobs(jobs, {
    engine, store, previous, accentCache: cache, engineLabel: 'VOICEVOX test', concurrency: 3,
    now: () => new Date('2026-10-15T00:00:00Z'),
  });
  return { result, engine, store };
}

// ---------------------------------------------------------------------------

describe('jobs', () => {
  const jobs = buildJobs(sources());
  const refs = byRef(jobs);

  it('has a clip for all 208 kana and the 142 kana example words, in the kana pack', () => {
    const kana = jobs.filter((j) => refKind(j.ref) === 'kana');
    expect(kana).toHaveLength(208);
    expect(kana.every((j) => j.pack === 'kana' && j.voice === 'f' && j.exact && j.text === j.ref.slice(5))).toBe(true);
    const ex = jobs.filter((j) => refKind(j.ref) === 'kanaEx');
    expect(ex).toHaveLength(142);
    expect(refs.get('kanaEx:け')).toMatchObject({ text: '{池|いけ}', reading: 'いけ', pack: 'kana' });
    expect(refs.get('kanaRule:hira-dakuten#1')).toMatchObject({ text: 'ごみ', reading: 'ごみ', pack: 'kana' });
  });

  it('gives both sides of every rule pair a kana: clip: extended katakana as exact sounds, contrast words as words', () => {
    const rule: KanaRule = {
      id: 'kata-extended', day: 14, script: 'katakana', title: '', explanation: '', practiceWords: [],
      pairs: [
        { from: 'か', to: 'が', romaji: 'ga' },
        { from: 'テ', to: 'ティ', romaji: 'ti' },
        { from: 'ウ', to: 'ヴ', romaji: 'vu' },
        { from: 'ヴ', to: 'ヴァ', romaji: 'va' },
        { from: 'おと', to: 'おっと', romaji: 'otto' },
        { from: 'ハト', to: 'ハート', romaji: 'haato' },
      ],
    };
    const all = buildJobs({ ...sources(), kanaRules: [rule] });
    const kana = all.filter((j) => refKind(j.ref) === 'kana');
    // The 208 sounds once each, then each side outside them once.
    expect(kana.slice(208).map((j) => j.ref)).toEqual(['kana:ティ', 'kana:ヴ', 'kana:ヴァ', 'kana:おと', 'kana:おっと', 'kana:ハト', 'kana:ハート']);
    expect(new Set(kana.map((j) => j.ref)).size).toBe(kana.length);
    const refs = byRef(all);
    for (const p of rule.pairs) for (const side of [p.from, p.to]) expect(refs.has(`kana:${side}`), side).toBe(true);
    expect(refs.get('kana:ティ')).toMatchObject({ kind: 'kana', exact: true, text: 'ティ', reading: 'ティ', voice: 'f', pack: 'kana' });
    expect(refs.get('kana:おっと')).toMatchObject({ kind: 'word', text: 'おっと', reading: 'おっと', voice: 'f', pack: 'kana' });
    expect(refs.get('kana:おっと')!.exact).toBeUndefined();
  });

  it('reads core and JMdict words as {written|kana}, in their unit or chapter pack', () => {
    expect(refs.get('core:cw-0002')).toMatchObject({ text: '{橋|はし}', reading: 'はし', pack: 'u01', word: { nounLike: true } });
    expect(refs.get('core:cw-0001')).toMatchObject({ text: 'ありがとう', pack: 'u01', word: { nounLike: false } });
    expect(refs.get('core:cw-0004')).toMatchObject({ pack: 'u04', word: { nounLike: false } });
    expect(refs.get('word:100')).toMatchObject({ text: '{箸|はし}', pack: 'c01', word: { nounLike: true } });
    expect(refs.get('word:102')).toMatchObject({ pack: 'c02' });
    // Core words come in teaching order.
    expect(jobs.filter((j) => j.family === 'core').map((j) => j.ref)).toEqual(['core:cw-0001', 'core:cw-0002', 'core:cw-0003', 'core:cw-0004']);
  });

  it('limits JMdict words to the anchors and staged words of the first N kanji', () => {
    expect(buildJobs(sources(), { kanjiLimit: 2 }).filter((j) => j.family === 'words').map((j) => j.ref)).toEqual(['word:100', 'word:102', 'word:103']);
    expect(buildJobs(sources(), { kanjiLimit: 0 }).some((j) => j.family === 'words')).toBe(false);
  });

  it('gives grammar, sentences, stories and units their unit pack', () => {
    expect(refs.get('grammar:desu#ex0')).toMatchObject({ kind: 'sentence', pack: 'u03', reading: 'あめです。' });
    expect(refs.get('grammar:desu#build0')).toMatchObject({ kind: 'sentence', pack: 'u03' });
    expect(refs.get('sentence:s-1')).toMatchObject({ pack: 'u04' });
    expect(refs.get('sentence:s-2')).toMatchObject({ pack: 'u01' });
    expect(refs.get('story:st-l0-01#0')).toMatchObject({ kind: 'story', pack: 'u05', phrases: storyFixture.phrases });
    expect(refs.get('task:u02-task#1')).toMatchObject({ kind: 'line', voice: 'm', pack: 'u02' });
    expect(refs.get('cando:u02-cd1')).toMatchObject({ voice: 'f', pack: 'u02', text: 'はい、そうです。' });
    // Only listen checks with material.
    expect(refs.has('cando:u02-cd2')).toBe(false);
    expect(refs.has('cando:u02-cd3')).toBe(false);
  });

  it('voices role a with f and role b with m; a role-play without a unit goes to misc', () => {
    expect(refs.get('rp:rp-u02#0')).toMatchObject({ voice: 'f', pack: 'u02', kind: 'line' });
    expect(refs.get('rp:rp-u02#1')).toMatchObject({ voice: 'm', pack: 'u02' });
    expect(refs.get('rp:rp-free#0')).toMatchObject({ voice: 'm', pack: 'misc' });
  });

  it('makes the pitch job: the word followed by が, in the word pack', () => {
    expect(pitchJobFor(refs.get('core:cw-0002')!)).toMatchObject({
      ref: 'pitch:core:cw-0002', kind: 'pitch', text: '{橋|はし}が', reading: 'はしが', pack: 'u01',
    });
  });

  it('samples every kind of job for a trial run', () => {
    const sample = sampleJobs(jobs, 20);
    expect(sample).toHaveLength(20);
    const kinds = new Set(sample.map((j) => refKind(j.ref)));
    for (const k of ['kana', 'kanaEx', 'kanaRule', 'core', 'word', 'grammar#ex', 'grammar#build', 'sentence', 'story', 'rp', 'task', 'cando']) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(sampleJobs(jobs, 20)).toEqual(sample);
    expect(sampleJobs(jobs, 1_000_000)).toHaveLength(jobs.length);
  });
});

describe('clip ids', () => {
  it('hash the voice, the plain text and the reading only (no engine version)', () => {
    const a = clipId({ voice: 'f', text: '{食|た}べる', reading: 'たべる' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(clipId({ voice: 'f', text: '{食べる|たべる}', reading: 'たべる' })).toBe(a);
    expect(clipId({ voice: 'm', text: '{食べる|たべる}', reading: 'たべる' })).not.toBe(a);
    expect(clipId({ voice: 'f', text: '{箸|はし}', reading: 'はし' })).not.toBe(clipId({ voice: 'f', text: '{橋|はし}', reading: 'はし' }));
    expect(clipFile(a)).toBe(`${a.slice(0, 2)}/${a}.m4a`);
  });

  it('keep a kana sound apart from a word of the same kana, and a story sentence apart from other refs', () => {
    const ha = { voice: 'f' as const, text: 'は', reading: 'は' };
    expect(clipId({ ...ha, exact: true })).not.toBe(clipId(ha));
    expect(clipId({ ...ha, exact: false })).toBe(clipId(ha));
    const s = { voice: 'f' as const, text: 'きょうはやすみです。', reading: 'きょうはやすみです。' };
    const story = clipId({ ...s, phrases: ['きょうは', 'やすみです。'] });
    expect(story).not.toBe(clipId(s));
    // Two stories with the same sentence and split share one clip; another split (a moved '／') is another clip.
    expect(clipId({ ...s, phrases: ['きょうは', 'やすみです。'] })).toBe(story);
    expect(clipId({ ...s, phrases: ['きょうはやすみです。'] })).not.toBe(story);
  });

  it('do not change when the engine changes', async () => {
    const jobs = buildJobs(sources()).filter((j) => j.family === 'core');
    const first = await run(jobs);
    const engine = new FakeEngine();
    const again = await runJobs(jobs, {
      engine, store: new MemoryStore(), previous: null, accentCache: {}, engineLabel: 'VOICEVOX 9.9.9',
    });
    expect(Object.keys(again.manifest.clips)).toEqual(Object.keys(first.result.manifest.clips));
    expect(again.manifest.engine).toBe('VOICEVOX 9.9.9');
  });
});

describe('run', () => {
  it('reuses every clip when nothing changed, without calling the engine', async () => {
    const jobs = buildJobs(sources());
    const first = await run(jobs);
    expect(first.result.failures.map((f) => f.ref)).toEqual([]);
    const second = await run(jobs, first.result.manifest, first.store, first.result.accentCache);
    expect(second.engine.queries).toHaveLength(0);
    expect(second.engine.syntheses).toHaveLength(0);
    expect(second.result.manifest).toEqual(first.result.manifest);
    expect(second.result.accent).toEqual(first.result.accent);
    expect(Object.values(second.result.stats).reduce((n, s) => n + s.generated, 0)).toBe(0);
  });

  it('keeps generatedAt when nothing changed, so a re-run leaves manifest.json byte-identical', async () => {
    const src = sources();
    const first = await run(buildJobs(src));
    const later = (jobs: AudioJob[], previous: AudioManifest, store: MemoryStore) =>
      runJobs(jobs, {
        engine: new FakeEngine(), store, previous, accentCache: first.result.accentCache, engineLabel: 'VOICEVOX test',
        now: () => new Date('2026-12-01T00:00:00Z'),
      });
    const same = await later(buildJobs(src), first.result.manifest, first.store);
    expect(same.manifest.generatedAt).toBe(first.result.manifest.generatedAt);
    expect(formatJsonLines(same.manifest as unknown as Record<string, unknown>)).toBe(
      formatJsonLines(first.result.manifest as unknown as Record<string, unknown>),
    );
    src.sentences[1] = { ...src.sentences[1], jp: 'いいえ。' };
    const changed = await later(buildJobs(src), first.result.manifest, first.store);
    expect(changed.manifest.generatedAt).toBe('2026-12-01T00:00:00.000Z');
  });

  it('regenerates only what changed and drops clips no longer referenced', async () => {
    const src = sources();
    const first = await run(buildJobs(src));
    src.sentences[1] = { ...src.sentences[1], jp: 'いいえ。' };
    const second = await run(buildJobs(src), first.result.manifest, first.store, first.result.accentCache);
    expect(second.engine.syntheses).toHaveLength(1);
    const oldId = first.result.manifest.byRef['sentence:s-2'];
    const newId = second.result.manifest.byRef['sentence:s-2'];
    expect(newId).not.toBe(oldId);
    // 'はい。' is still used by a grammar example, a task line and a role-play line with voice f.
    expect(second.result.manifest.clips[oldId]).toBeDefined();
  });

  it('synthesizes a clip shared by several refs once, in the pack needed first', async () => {
    const jobs = buildJobs(sources());
    const { result, engine } = await run(jobs);
    const m = result.manifest;
    // core:cw-0002 and word:103 are both {橋|はし}: one clip, in u01 (before chapter c02), one synthesis.
    expect(m.byRef['word:103']).toBe(m.byRef['core:cw-0002']);
    expect(m.clips[m.byRef['word:103']].pack).toBe('u01');
    expect(engine.syntheses.filter((s) => s.moras === 'ハシ')).toHaveLength(3); // 箸, 橋, 端
    expect(result.accent['word:103']).toEqual(result.accent['core:cw-0002']);
    expect(m.byRef['pitch:word:103']).toBe(m.byRef['pitch:core:cw-0002']);
    const hai = m.byRef['sentence:s-2'];
    expect(m.byRef['grammar:desu#ex1']).toBe(hai);
    expect(m.byRef['rp:rp-u02#0']).toBe(hai);
    expect(m.byRef['task:u02-task#0']).toBe(hai);
    expect(m.clips[hai].pack).toBe('u01');
    expect(engine.syntheses.filter((s) => s.moras === 'ハイ' && s.speaker === 30)).toHaveLength(1);
    // Counted once as generated; the other refs reuse it.
    const totals = Object.values(result.stats).reduce((t, s) => ({ generated: t.generated + s.generated, reused: t.reused + s.reused }), { generated: 0, reused: 0 });
    expect(totals.generated).toBe(Object.keys(m.clips).length);
    expect(totals.generated).toBe(engine.syntheses.length);
    expect(totals.generated + totals.reused).toBe(Object.keys(m.byRef).length);
    expect(result.stats.pitch.jobs).toBe(Object.keys(m.byRef).filter((r) => r.startsWith('pitch:')).length);
    // Role b is the male voice (speaker 13).
    expect(m.clips[m.byRef['rp:rp-u02#1']].voice).toBe('m');
    expect(engine.syntheses.some((s) => s.moras === 'イイエ' && s.speaker === 13)).toBe(true);
  });

  it('makes a clip for each side of the rule pairs, so the pair grid never falls back to the device voice', async () => {
    const rule: KanaRule = {
      id: 'hira-yoon', day: 7, script: 'hiragana', title: '', explanation: '', practiceWords: [],
      pairs: [{ from: 'テ', to: 'ティ', romaji: 'ti' }, { from: 'おと', to: 'おっと', romaji: 'otto' }, { from: 'ビル', to: 'ビール', romaji: 'biiru' }],
    };
    const jobs = buildJobs({ ...sources(), kanaRules: [rule] }).filter((j) => /^kana:(ティ|おと|おっと|ビル|ビール)$/.test(j.ref));
    const { result, engine } = await run(jobs);
    expect(result.failures).toEqual([]);
    const m = result.manifest;
    for (const side of ['ティ', 'おと', 'おっと', 'ビル', 'ビール']) expect(m.clips[m.byRef[`kana:${side}`]], side).toMatchObject({ pack: 'kana', voice: 'f', via: 'text' });
    expect(engine.syntheses.map((s) => s.moras).sort()).toEqual(['オット', 'オト', 'ティ', 'ビル', 'ビール'].sort());
  });

  it('reads a lone は as "ha" from the katakana, never as the particle "wa"', async () => {
    const jobs = buildJobs(sources()).filter((j) => j.ref === 'kana:は' || j.ref === 'kana:ハ');
    const { result, engine } = await run(jobs);
    expect(result.manifest.clips[result.manifest.byRef['kana:は']].via).toBe('kana');
    expect(result.manifest.clips[result.manifest.byRef['kana:ハ']].via).toBe('text');
    // Two clips (different text), both saying ハ; the engine's ワ is never synthesized.
    expect(engine.syntheses.map((s) => s.moras)).toEqual(['ハ', 'ハ']);
  });

  it('records a failure when the engine misreads both the text and the reading', async () => {
    const job: AudioJob = { ref: 'sentence:x', family: 'sentences', kind: 'sentence', voice: 'f', text: '{人気|ひとけ}', reading: 'ひとけ', pack: 'u01' };
    recorded['なに'] = fakeQuery('なん');
    const { result } = await run([job, { ...job, ref: 'sentence:y', text: '{何|なに}', reading: 'なに' }]);
    delete recorded['なに'];
    expect(result.failures).toEqual([{ ref: 'sentence:y', text: '{何|なに}', reading: 'なに', heard: ['アア', 'ナン'] }]);
    expect(result.manifest.byRef['sentence:x']).toBeDefined();
    expect(result.manifest.byRef['sentence:y']).toBeUndefined();
    expect(result.missing).toBe(1);
    expect(result.stats.sentence).toMatchObject({ jobs: 2, generated: 1, failed: 1, viaKana: 1 });
  });

  it('reports each ref of a failed clip under its own name', async () => {
    const job: AudioJob = { ref: 'sentence:y', family: 'sentences', kind: 'sentence', voice: 'f', text: '{何|なに}', reading: 'なに', pack: 'u01' };
    recorded['なに'] = fakeQuery('なん');
    const { result, engine } = await run([job, { ...job, ref: 'grammar:g#ex0', family: 'grammar' }]);
    delete recorded['なに'];
    expect(result.failures.map((f) => f.ref).sort()).toEqual(['grammar:g#ex0', 'sentence:y']);
    expect(engine.queries).toHaveLength(2);
  });

  it('fails a job whose reading still has a kanji without calling the engine', async () => {
    const job: AudioJob = { ref: 'sentence:z', family: 'sentences', kind: 'sentence', voice: 'f', text: '{私|わたし}は学生', reading: 'わたしは学生', pack: 'u01' };
    const { result, engine } = await run([job]);
    expect(result.failures[0]).toMatchObject({ ref: 'sentence:z', error: 'the reading still contains kanji' });
    expect(engine.queries).toHaveLength(0);
  });

  it('stops early with what it has when the engine stops answering', async () => {
    const jobs = buildJobs(sources()).filter((j) => j.family === 'kana').slice(0, 30);
    const engine = new FakeEngine();
    let calls = 0;
    const flaky: Engine = {
      query: (t, s) => (++calls > 10 ? Promise.reject(new Error('ECONNREFUSED')) : engine.query(t, s)),
      synthesize: (q, s) => engine.synthesize(q, s),
    };
    const result = await runJobs(jobs, {
      engine: flaky, store: new MemoryStore(), previous: null, accentCache: {}, engineLabel: 'x', concurrency: 1, maxConsecutiveErrors: 3,
    });
    expect(result.aborted).toMatch(/ECONNREFUSED/);
    expect(Object.keys(result.manifest.byRef).length).toBeGreaterThan(0);
    expect(Object.keys(result.manifest.byRef).length).toBeLessThan(30);
  });

  it('writes a checkpoint every N new clips', async () => {
    const jobs = buildJobs(sources()).filter((j) => j.family === 'kana').slice(0, 25);
    const sizes: number[] = [];
    await runJobs(jobs, {
      engine: new FakeEngine(), store: new MemoryStore(), previous: null, accentCache: {}, engineLabel: 'x', concurrency: 2,
      checkpointEvery: 10, onCheckpoint: ({ manifest }) => sizes.push(Object.keys(manifest.byRef).length),
    });
    expect(sizes).toEqual([10, 20]);
  });

  it('plans without an engine (dry run)', async () => {
    const jobs = buildJobs(sources());
    const result = await runJobs(jobs, { engine: null, store: new MemoryStore(), previous: null, accentCache: {}, engineLabel: 'x' });
    expect(Object.keys(result.manifest.clips)).toHaveLength(0);
    expect(result.missing).toBe(jobs.length);
    expect(result.stats.kana.pending).toBe(208);
  });

  it('attaches a clip shared with a selected job in the same run, so a repeated sample run is a no-op', async () => {
    const src = sources();
    src.coreWords.push(core('cw-0005', 5, 'かぎ', undefined, 'noun', 2));
    const jobs = buildJobs(src);
    const selected = new Set(['kanaRule:hira-dakuten#0', 'core:cw-0002']);
    const once = async (previous: AudioManifest | null, store: MemoryStore, accentCache = {}) => {
      const engine = new FakeEngine();
      const result = await runJobs(jobs, {
        engine, store, previous, accentCache, engineLabel: 'x', selected, pitch: false, now: () => new Date(0),
      });
      return { result, engine };
    };
    const store = new MemoryStore();
    const first = await once(null, store);
    // core:cw-0005 is the same clip as kanaRule:hira-dakuten#0 (かぎ): attached, though not selected.
    expect(first.result.manifest.byRef['core:cw-0005']).toBe(first.result.manifest.byRef['kanaRule:hira-dakuten#0']);
    // Only the selected word was measured: word:103 shares 橋's clip and gets its cached accent, but nothing else ran.
    expect(Object.keys(first.result.accent).sort()).toEqual(['core:cw-0002', 'word:103']);
    const second = await once(first.result.manifest, store, first.result.accentCache);
    expect(second.engine.queries).toHaveLength(0);
    expect(second.result.manifest).toEqual(first.result.manifest);
    expect(second.result.accent).toEqual(first.result.accent);
  });

  it('only generates the selected jobs and carries the rest over', async () => {
    const jobs = buildJobs(sources());
    const first = await run(jobs.filter((j) => j.family === 'core'));
    const selected = new Set(jobs.filter((j) => j.family === 'grammar').map((j) => j.ref));
    const engine = new FakeEngine();
    const result = await runJobs(jobs, {
      engine, store: first.store, previous: first.result.manifest, accentCache: first.result.accentCache, engineLabel: 'x', selected,
    });
    expect(result.stats.core.reused).toBe(4);
    expect(result.stats['grammar#ex'].generated).toBe(2);
    expect(result.stats.kana.pending).toBe(208);
    expect(result.manifest.byRef['pitch:core:cw-0002']).toBe(first.result.manifest.byRef['pitch:core:cw-0002']);
  });
});

describe('byText', () => {
  it('indexes every clip under its clipTextKey, and plain-only keys only when unambiguous', async () => {
    const src = sources();
    src.sentences.push(
      { id: 's-k1', jp: '{今日|きょう}', en: '', grammar: [], tokens: [], refs: [], unit: 1 },
      { id: 's-k2', jp: '{今日|こんにち}', en: '', grammar: [], tokens: [], refs: [], unit: 1 },
    );
    recorded['今日'] = fakeQuery('きょう');
    const jobs = buildJobs(src);
    const { result } = await run(jobs);
    const m = result.manifest;
    for (const job of jobs) {
      const id = m.byRef[job.ref];
      if (id) expect(m.byText[clipTextKey(job.voice, job.text)]).toBeDefined();
    }
    expect(m.byText['f|橋|はし']).toBe(m.byRef['core:cw-0002']);
    expect(m.byText['f|箸|はし']).toBe(m.byRef['word:100']);
    // 箸, 橋 and 端 have distinct plain text: each plain-only key is unambiguous.
    expect(m.byText['f|箸|']).toBe(m.byRef['word:100']);
    // 今日 has two readings: no plain-only key, so a plain 今日 never plays the wrong one.
    expect(m.byText['f|今日|きょう']).toBe(m.byRef['sentence:s-k1']);
    expect(m.byText['f|今日|']).toBeUndefined();
    // Voices are kept apart.
    expect(m.byText['m|いいえ。|いいえ。']).toBe(m.byRef['rp:rp-u02#1']);
    expect(m.byText['f|いいえ。|いいえ。']).toBeUndefined();
    delete recorded['今日'];
  });

  it('writes the manifest and accent files one entry per line as valid JSON', async () => {
    const { result } = await run(buildJobs(sources()));
    const text = formatJsonLines(result.manifest as unknown as Record<string, unknown>);
    expect(JSON.parse(text)).toEqual(result.manifest);
    // One line per clip, ref and text key, plus the top-level lines.
    const m = result.manifest;
    expect(text.split('\n')).toHaveLength(Object.keys(m.clips).length + Object.keys(m.byRef).length + Object.keys(m.byText).length + 13);
    const empty = { version: 1, generatedAt: '', engine: '', credits: [], clips: {}, byRef: {}, byText: {} };
    expect(JSON.parse(formatJsonLines(empty))).toEqual(empty);
    expect(JSON.parse(formatRecordLines(result.accent))).toEqual(result.accent);
    expect(formatRecordLines(result.accent).split('\n')).toHaveLength(Object.keys(result.accent).length + 3);
    expect(JSON.parse(formatRecordLines({}))).toEqual({});
  });

  it('keys are sorted and credits name both voices', () => {
    const job: AudioJob = { ref: 'kana:あ', family: 'kana', kind: 'kana', voice: 'f', text: 'あ', reading: 'あ', pack: 'kana' };
    const m = buildManifest([{ job, id: 'b', clip: { file: 'b', ms: 1, voice: 'f', pack: 'kana', via: 'text' } },
      { job: { ...job, ref: 'kana:い', text: 'い' }, id: 'a', clip: { file: 'a', ms: 1, voice: 'f', pack: 'kana', via: 'text' } }], 'VOICEVOX x', 't');
    expect(Object.keys(m.clips)).toEqual(['a', 'b']);
    expect(m.credits).toEqual(['VOICEVOX:No.7', 'VOICEVOX:青山龍星']);
  });
});

describe('accent and pitch clips', () => {
  it('records the が accent of a noun read via its kanji, with a pitch: clip ending in が', async () => {
    const jobs = buildJobs(sources());
    const { result, engine } = await run(jobs);
    expect(result.accent['core:cw-0002']).toEqual({ moras: ['ハ', 'シ'], drop: 2, type: 'odaka', withGa: true });
    expect(result.accent['word:100']).toEqual({ moras: ['ハ', 'シ'], drop: 1, type: 'atamadaka', withGa: true });
    expect(result.accent['word:101']).toEqual({ moras: ['ハ', 'シ'], drop: 0, type: 'heiban', withGa: true });
    expect(result.accent['word:102']).toMatchObject({ drop: 1, type: 'atamadaka', withGa: true });
    const pitchId = result.manifest.byRef['pitch:core:cw-0002'];
    expect(pitchId).toBe(clipId(pitchJobFor(byRef(jobs).get('core:cw-0002')!)));
    expect(result.manifest.clips[pitchId]).toMatchObject({ pack: 'u01', via: 'text' });
    // The pitch clip is synthesized from the verified が query.
    expect(engine.syntheses.filter((s) => s.moras === 'ハシガ')).toHaveLength(3);
  });

  it('records no accent and no pitch clip for a word read via kana', async () => {
    const jobs = buildJobs(sources());
    const { result } = await run(jobs);
    const id = result.manifest.byRef['core:cw-0003'];
    expect(result.manifest.clips[id].via).toBe('kana');
    expect(result.accent['core:cw-0003']).toBeUndefined();
    expect(result.manifest.byRef['pitch:core:cw-0003']).toBeUndefined();
  });

  it('records a kana-only word read from its own kana, without が for a non-noun', async () => {
    const { result } = await run(buildJobs(sources()));
    expect(result.accent['core:cw-0001']).toMatchObject({ moras: ['ア', 'リ', 'ガ', 'ト', 'ウ'] });
    expect(result.accent['core:cw-0001'].withGa).toBeUndefined();
    expect(result.manifest.byRef['pitch:core:cw-0001']).toBeUndefined();
  });

  it('gives sentence clips their phrase accents only when read via the text', async () => {
    const { result } = await run(buildJobs(sources()));
    const m = result.manifest;
    const viaKana = m.clips[m.byRef['sentence:s-1']];
    expect(viaKana.via).toBe('kana');
    expect(viaKana.accentPhrases).toBeUndefined();
    const story = m.clips[m.byRef['story:st-l0-01#0']];
    expect(story.via).toBe('text');
    expect(story.accentPhrases?.[0]).toEqual(['ワタシワ', 4]);
    expect(story.phrases).toHaveLength(3);
    expect(story.phrases![0]).toBe(96);
    // Word clips carry no phrase accents.
    expect(m.clips[m.byRef['core:cw-0002']].accentPhrases).toBeUndefined();
  });

  it('measures a clip shared by a noun and a non-noun once, with が, and a re-run is a no-op', async () => {
    const src = sources();
    src.coreWords.push(core('cw-0010', 10, 'そば', undefined, 'noun', 2), core('cw-0011', 11, 'そば', undefined, 'adverb', 2));
    const jobs = buildJobs(src);
    const first = await run(jobs);
    const id = first.result.manifest.byRef['core:cw-0010'];
    expect(first.result.manifest.byRef['core:cw-0011']).toBe(id);
    expect(first.result.accentCache[id]).toMatchObject({ noun: true });
    expect(first.result.accent['core:cw-0010']).toMatchObject({ withGa: true });
    expect(first.result.accent['core:cw-0011']).toEqual(first.result.accent['core:cw-0010']);
    for (let i = 0; i < 2; i++) {
      const again = await run(jobs, first.result.manifest, first.store, first.result.accentCache);
      expect(again.engine.queries).toHaveLength(0);
      expect(again.result.accent).toEqual(first.result.accent);
      expect(again.result.manifest).toEqual(first.result.manifest);
    }
  });

  it('keeps the accent cache by clip id so a re-run needs no engine', async () => {
    const jobs = buildJobs(sources());
    const first = await run(jobs);
    const id = first.result.manifest.byRef['core:cw-0002'];
    expect(first.result.accentCache[id]).toEqual({ noun: true, accent: first.result.accent['core:cw-0002'] });
    const again = await run(jobs, first.result.manifest, first.store, first.result.accentCache);
    expect(again.result.accent).toEqual(first.result.accent);
    expect(again.result.manifest.byRef['pitch:core:cw-0002']).toBe(first.result.manifest.byRef['pitch:core:cw-0002']);
  });
});

describe('clips shared by different kinds of refs', () => {
  const kanaHa = (): AudioJob => buildJobs(sources()).find((j) => j.ref === 'kana:は')!;
  const wordHa: AudioJob = {
    ref: 'core:cw-0009', family: 'core', kind: 'word', voice: 'f', text: 'は', reading: 'は', pack: 'u01', word: { nounLike: false },
  };

  it('never lets a word read "wa" give the kana は its sound, whichever job runs first', async () => {
    for (const jobs of [[kanaHa(), wordHa], [wordHa, kanaHa()]]) {
      const { result, engine } = await run(jobs);
      const m = result.manifest;
      expect(m.byRef['kana:は']).not.toBe(m.byRef['core:cw-0009']);
      expect(m.clips[m.byRef['kana:は']].via).toBe('kana');
      expect(m.clips[m.byRef['core:cw-0009']].via).toBe('text');
      expect(engine.syntheses.map((s) => s.moras).sort()).toEqual(['ハ', 'ワ']);
    }
  });

  it('gives a story sentence its phrase offsets even when a grammar example has the same text', async () => {
    const src = sources();
    src.grammar[0].examples.push({ jp: story.sentences[0].jp, en: 'I drink coffee every morning.' });
    const jobs = buildJobs(src);
    const ex = `grammar:desu#ex${src.grammar[0].examples.length - 1}`;
    for (const order of [jobs, [...jobs].reverse()]) {
      const m = (await run(order)).result.manifest;
      const storyClip = m.clips[m.byRef['story:st-l0-01#0']];
      expect(storyClip.phrases).toHaveLength(3);
      expect(storyClip.accentPhrases?.[0]).toEqual(['ワタシワ', 4]);
      expect(m.byRef[ex]).not.toBe(m.byRef['story:st-l0-01#0']);
      expect(m.clips[m.byRef[ex]].phrases).toBeUndefined();
      expect(m.clips[m.byRef[ex]].accentPhrases).toEqual(storyClip.accentPhrases);
      // Both clips say the same reading: the plain text stays unambiguous.
      const key = clipTextKey('f', story.sentences[0].jp);
      expect(m.byText[key.slice(0, key.lastIndexOf('|') + 1)]).toBe(m.byText[key]);
    }
  });

  const hai: AudioJob = {
    ref: 'core:cw-0100', family: 'core', kind: 'word', voice: 'f', text: 'はい', reading: 'はい', pack: 'u01', word: { nounLike: false },
  };
  const haiLine: AudioJob = { ref: 'rp:rp-x#0', family: 'roleplays', kind: 'line', voice: 'f', text: 'はい', reading: 'はい', pack: 'u02' };

  it('gives a clip shared by a word and a sentence-type line its phrase accents, whichever job runs first', async () => {
    const a = (await run([hai, haiLine])).result.manifest;
    const b = (await run([haiLine, hai])).result.manifest;
    expect(a.byRef['core:cw-0100']).toBe(a.byRef['rp:rp-x#0']);
    expect(a.clips[a.byRef['rp:rp-x#0']].accentPhrases).toEqual([['ハイ', 1]]);
    expect(b).toEqual(a);
  });

  it('remakes a carried word clip that a sentence-type line now shares, and strips phrase accents nobody needs', async () => {
    const first = await run([hai]);
    expect(first.result.manifest.clips[first.result.manifest.byRef['core:cw-0100']].accentPhrases).toBeUndefined();
    // Not selected this run: carried as it is, without calling the engine.
    const idle = await runJobs([hai, haiLine], {
      engine: new FakeEngine(), store: first.store, previous: first.result.manifest, accentCache: first.result.accentCache,
      engineLabel: 'x', selected: new Set(),
    });
    expect(idle.manifest.clips[idle.manifest.byRef['rp:rp-x#0']].accentPhrases).toBeUndefined();
    // Selected: remade once with its phrase accents, as a fresh run would make it.
    const second = await run([hai, haiLine], first.result.manifest, first.store, first.result.accentCache);
    expect(second.engine.syntheses).toHaveLength(1);
    const fresh = (await run([hai, haiLine])).result.manifest;
    expect(second.result.manifest).toEqual(fresh);
    // The line is gone again: the carried clip drops the phrase accents, as a fresh run of the word alone has none.
    const third = await run([hai], second.result.manifest, second.store, second.result.accentCache);
    expect(third.engine.syntheses).toHaveLength(0);
    expect(third.result.manifest).toEqual(first.result.manifest);
  });
});

describe('pitch clips stay consistent with accent.json', () => {
  it('drops a cached accent when the が query made now gives another accent, and keeps it when it agrees', async () => {
    const jobs = buildJobs(sources());
    const first = await run(jobs);
    const pitchFile = first.result.manifest.clips[first.result.manifest.byRef['pitch:core:cw-0002']].file;
    expect(first.result.accent['core:cw-0002']).toMatchObject({ drop: 2, withGa: true });

    // The pitch clip is gone and the engine now reads 橋が like 端が (heiban): no pitch clip that contradicts drop 2.
    const lost = new MemoryStore();
    for (const [f, n] of first.store.files) if (f !== pitchFile) lost.files.set(f, n);
    const saved = recorded['橋が'];
    recorded['橋が'] = recorded['端が'];
    const changed = await run(jobs, first.result.manifest, lost, first.result.accentCache);
    recorded['橋が'] = saved;
    expect(changed.result.manifest.byRef['pitch:core:cw-0002']).toBeUndefined();
    expect(changed.result.accent['core:cw-0002']).toBeUndefined();
    expect(changed.result.accent['word:103']).toBeUndefined();
    expect(changed.result.warnings.some((w) => w.startsWith('pitch:core:cw-0002') || w.startsWith('pitch:word:103'))).toBe(true);

    // Same engine as before: the pitch clip is remade and the accent kept.
    const again = new MemoryStore();
    for (const [f, n] of first.store.files) if (f !== pitchFile) again.files.set(f, n);
    const same = await run(jobs, first.result.manifest, again, first.result.accentCache);
    expect(same.result.manifest).toEqual(first.result.manifest);
    expect(same.result.accent).toEqual(first.result.accent);
    expect(same.engine.syntheses.map((s) => s.moras)).toEqual(['ハシガ']);
  });

  it('never carries a pitch clip for a word whose clip was read via kana', async () => {
    const jobs = buildJobs(sources());
    const first = await run(jobs);
    const word = byRef(jobs).get('core:cw-0003')!;
    const id = first.result.manifest.byRef['core:cw-0003'];
    expect(first.result.manifest.clips[id].via).toBe('kana');
    // A stale cache entry and a leftover pitch clip (say, from an engine that once read 人気 as ひとけ).
    const pitch = pitchJobFor(word);
    const pid = clipId(pitch);
    const previous: AudioManifest = {
      ...first.result.manifest,
      clips: { ...first.result.manifest.clips, [pid]: { file: clipFile(pid), ms: 500, voice: 'f', pack: 'u03', via: 'text' } },
      byRef: { ...first.result.manifest.byRef, [pitch.ref]: pid },
    };
    first.store.files.set(clipFile(pid), 1);
    const cache = { ...first.result.accentCache, [id]: { noun: true, accent: { moras: ['ヒ', 'ト', 'ケ'], drop: 0, type: 'heiban' as const, withGa: true as const } } };
    const { result } = await run(jobs, previous, first.store, cache);
    expect(result.manifest.byRef[pitch.ref]).toBeUndefined();
    expect(result.accent['core:cw-0003']).toBeUndefined();
  });
});
