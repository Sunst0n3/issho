// @vitest-environment jsdom
// The generated public/audio, checked through the app's own playback code (src/speech/audio.ts) against the current
// data build: every clip ref the screens ask for plays a clip, and the clip it plays was made for the current text
// and reading (a stale build would play the old sentence); text lookups find the clip of that reading, homographs
// never share one, and the packs cover every clip. Skipped until `npm run build:audio` has written the manifest.
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KanaExamplesFile } from '../src/lib/data.ts';
import type {
  AccentFile,
  AudioManifest,
  CoreWord,
  Curriculum,
  GrammarPoint,
  KanaEntry,
  KanaRule,
  RolePlay,
  SentenceEntry,
  StoryEntry,
  UnitSpec,
  VoiceId,
  WordEntry,
} from '../src/lib/types.ts';
import { hasClip, packsFor, play, resetAudio, type AudioSource } from '../src/speech/audio.ts';
import { clipRef, clipTextKey } from '../shared/voicevox.ts';
import { DEFAULT_KANJI_LIMIT, buildJobs, clipFile, clipId, type AudioJob } from './audio/jobs.ts';

// jsdom gives test modules an http import.meta.url: resolve from the project root, where vitest runs.
const DATA = join(process.cwd(), 'public', 'data') + sep;
const AUDIO = join(process.cwd(), 'public', 'audio') + sep;
const read = <T,>(file: string): T => JSON.parse(readFileSync(DATA + file, 'utf8')) as T;
const generated =
  existsSync(`${AUDIO}manifest.json`) &&
  existsSync(`${DATA}curriculum.json`) &&
  read<{ version?: number }>('curriculum.json').version === 2 &&
  Object.keys((JSON.parse(readFileSync(`${AUDIO}manifest.json`, 'utf8')) as AudioManifest).clips).length > 0;

/** What a screen passes to play(): the source, its fallback text and voice (as in KanaLesson, WordReadCard, …). */
interface Request {
  ref: string;
  fallbackText: string;
  voice: VoiceId;
}

/** The design allows up to 1 % of jobs without a clip (the engine misread both the text and its reading). */
const MAX_MISSING = 0.01;

describe.skipIf(!generated)('generated audio, through the app playback code', () => {
  let manifest: AudioManifest;
  let jobs: Map<string, AudioJob>;
  let requests: Request[];
  let accent: AccentFile;
  /** Clip files fetched by play(), in order. */
  const fetched: string[] = [];

  beforeAll(() => {
    const manifestText = readFileSync(`${AUDIO}manifest.json`, 'utf8');
    manifest = JSON.parse(manifestText) as AudioManifest;
    accent = existsSync(`${DATA}accent.json`) ? read<AccentFile>('accent.json') : {};

    const kana = read<KanaEntry[]>('kana.json');
    const kanaExamples = read<KanaExamplesFile>('content/kana-examples.json');
    const kanaRules = read<KanaRule[]>('content/kana-rules.json');
    const coreWords = read<CoreWord[]>('content/core-words.json');
    const words = read<WordEntry[]>('words.json');
    const curriculum = read<Curriculum>('curriculum.json');
    const grammar = read<GrammarPoint[]>('content/grammar.json');
    const sentences = read<SentenceEntry[]>('content/sentences.json');
    const stories = existsSync(`${DATA}content/stories.json`) ? read<StoryEntry[]>('content/stories.json') : [];
    const rolePlays = existsSync(`${DATA}content/roleplays.json`) ? read<RolePlay[]>('content/roleplays.json') : [];
    const units = existsSync(`${DATA}content/units.json`) ? read<UnitSpec[]>('content/units.json') : [];
    jobs = new Map(
      buildJobs({ kana, kanaExamples, kanaRules, coreWords, words, curriculum, grammar, sentences, stories, rolePlays, units }).map((j) => [j.ref, j]),
    );

    // The requests, built the way the screens build them (clipRef + the text they fall back to).
    const speech = (written: string | undefined, kanaText: string) => (written && written !== kanaText ? `{${written}|${kanaText}}` : kanaText);
    const f = (ref: string, fallbackText: string): Request => ({ ref, fallbackText, voice: 'f' });
    const byRole = (role: string): VoiceId => (role === 'b' ? 'm' : 'f');
    // The rule lessons' pair grids play both sides of a pair (テ→ティ, おと→おっと); sides that are basic kana are above.
    const kanaChars = new Set(kana.map((k) => k.char));
    const pairSides = [...new Set(kanaRules.flatMap((r) => r.pairs.flatMap((p) => [p.from, p.to])))].filter((s) => !kanaChars.has(s));
    requests = [
      ...kana.map((k) => f(clipRef.kana(k.char), k.char)),
      ...pairSides.map((side) => f(clipRef.kana(side), side)),
      ...Object.entries(kanaExamples).map(([char, ex]) => f(clipRef.kanaEx(char), ex.kana)),
      ...kanaRules.flatMap((r) => r.practiceWords.map((w, n) => f(clipRef.kanaRule(r.id, n), w.kana))),
      ...coreWords.map((c) => f(clipRef.word(`core:${c.id}`), speech(c.written, c.kana))),
      ...grammar.flatMap((g) => [
        ...g.examples.map((ex, n) => f(clipRef.grammarExample(g.id, n), ex.jp)),
        ...g.buildItems.map((b, n) => f(clipRef.grammarBuild(g.id, n), b.jp)),
      ]),
      ...sentences.map((s) => f(clipRef.sentence(s.id), s.jp)),
      ...stories.flatMap((st) => st.sentences.map((s, n) => f(clipRef.story(st.id, n), s.jp))),
      ...rolePlays.flatMap((rp) => rp.lines.map((l, n) => ({ ref: clipRef.rolePlay(rp.id, n), fallbackText: l.jp, voice: byRole(l.role) }))),
      ...units.flatMap((u) => [
        ...u.task.scripted.map((l, n) => ({ ref: clipRef.task(u.task.id, n), fallbackText: l.jp, voice: byRole(l.role) })),
        ...u.canDos.filter((cd) => cd.check.kind === 'listen' && cd.check.material.trim()).map((cd) => f(clipRef.canDo(cd.id), cd.check.material)),
      ]),
    ];
    // JMdict words of the generated scope: anchors and staged words of the first DEFAULT_KANJI_LIMIT kanji.
    const wordsById = new Map(words.map((w) => [w.id, w]));
    const seen = new Set<string>();
    for (const unit of [...curriculum.units].sort((a, b) => a.index - b.index)) {
      if (unit.index >= DEFAULT_KANJI_LIMIT) break;
      for (const ref of [unit.anchor, ...unit.staged]) {
        if (!ref?.startsWith('word:') || seen.has(ref)) continue;
        const w = wordsById.get(ref.slice('word:'.length));
        if (!w) continue;
        seen.add(ref);
        requests.push(f(clipRef.word(ref), speech(w.written, w.kana)));
      }
    }

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = decodeURIComponent(new URL(href, 'http://localhost/').pathname);
      if (path === '/audio/manifest.json') return new Response(manifestText, { headers: { 'content-type': 'application/json' } });
      if (path.startsWith('/audio/')) {
        const file = path.slice('/audio/'.length);
        fetched.push(file);
        if (!existsSync(AUDIO + file)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        return new Response(readFileSync(AUDIO + file), { headers: { 'content-type': 'audio/mp4' } });
      }
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    });
  });

  afterAll(() => {
    resetAudio();
    vi.unstubAllGlobals();
  });

  /** The clip file play() fetched for a source, or null when it played no clip. */
  async function playedFile(source: AudioSource, opts: { fallbackText?: string; voice?: VoiceId } = {}): Promise<string | null> {
    const before = fetched.length;
    const result = await play(source, { ...opts, rate: 1 });
    return result.via === 'clip' && fetched.length > before ? fetched[fetched.length - 1] : null;
  }

  it('covers every job of the current data with a request, and a request for every job', () => {
    const asked = new Set(requests.map((r) => r.ref));
    expect([...jobs.keys()].filter((ref) => !asked.has(ref))).toEqual([]);
    expect([...asked].filter((ref) => !jobs.has(ref))).toEqual([]);
  });

  it('plays, for every clip ref a screen asks for, the clip made for its current text and reading', async () => {
    const missing: string[] = [];
    const stale: string[] = [];
    for (const r of requests) {
      const file = await playedFile({ ref: r.ref }, { fallbackText: r.fallbackText, voice: r.voice });
      if (!file) {
        missing.push(r.ref);
        continue;
      }
      const job = jobs.get(r.ref)!;
      if (file !== clipFile(clipId(job))) stale.push(`${r.ref}: plays ${file}, current is ${clipFile(clipId(job))} (${job.text})`);
    }
    // A clip missing for a ref is an engine failure only when the manifest has no clip for it either.
    expect(missing.filter((ref) => ref in manifest.byRef)).toEqual([]);
    expect(missing.length, `refs without a clip: ${missing.slice(0, 20).join(', ')}`).toBeLessThanOrEqual(Math.floor(requests.length * MAX_MISSING));
    expect(stale.slice(0, 20)).toEqual([]);
  }, 120_000);

  it('has a clip for every kana sound and for both sides of every rule pair (no device-voice fallback in the sprint)', () => {
    const kanaRefs = requests.filter((r) => r.ref.startsWith('kana:')).map((r) => r.ref);
    expect(kanaRefs.length).toBeGreaterThan(208);
    expect(kanaRefs.filter((ref) => !(ref in manifest.byRef))).toEqual([]);
  });

  it('gives each role-play and task line the voice of its role', () => {
    const wrong = requests
      .filter((r) => r.ref.startsWith('rp:') || r.ref.startsWith('task:'))
      .filter((r) => r.ref in manifest.byRef && manifest.clips[manifest.byRef[r.ref]].voice !== r.voice)
      .map((r) => r.ref);
    expect(wrong).toEqual([]);
    expect(Object.values(manifest.clips).some((c) => c.voice === 'm')).toBe(true);
  });

  it('plays a pitch: clip for every word whose accent was measured with が, and only for those', async () => {
    const withGa = Object.entries(accent).filter(([, a]) => a.withGa).map(([ref]) => ref);
    expect(withGa.length).toBeGreaterThan(0);
    const without: string[] = [];
    for (const ref of withGa) if (!(await hasClip({ ref: clipRef.pitch(ref) }))) without.push(ref);
    expect(without).toEqual([]);
    const pitchRefs = Object.keys(manifest.byRef).filter((ref) => ref.startsWith('pitch:'));
    expect(pitchRefs.filter((ref) => !accent[ref.slice('pitch:'.length)]?.withGa)).toEqual([]);
  }, 60_000);

  /** Clips by their full text key (voice|plain|reading), with one job that has that key. */
  function clipsByTextKey(): Map<string, { job: AudioJob; ids: Set<string> }> {
    const out = new Map<string, { job: AudioJob; ids: Set<string> }>();
    for (const job of jobs.values()) {
      if (!(job.ref in manifest.byRef)) continue;
      const key = clipTextKey(job.voice, job.text);
      const entry = out.get(key) ?? { job, ids: new Set<string>() };
      entry.ids.add(manifest.byRef[job.ref]);
      out.set(key, entry);
    }
    return out;
  }
  const idOf = (file: string | null) => file?.replace(/^.*\//, '').replace(/\.m4a$/, '');

  it('finds by text (ruby, as the screens pass it) a clip of that text and reading', async () => {
    // A text may have several clips that say the same thing (a story sentence also carries phrase offsets).
    const wrong: string[] = [];
    for (const [key, { job, ids }] of clipsByTextKey()) {
      const file = await playedFile({ text: job.text, voice: job.voice });
      if (!ids.has(idOf(file) ?? '')) wrong.push(`${key}: ${file ?? 'no clip'}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  }, 120_000);

  it('finds plain kanji text without ruby only when one reading has a clip; homographs keep their own clips', async () => {
    // Full keys by their plain-only key ('f|人|'): two readings of one spelling (人 じん / にん) are homographs.
    const byPlain = new Map<string, string[]>();
    const keys = clipsByTextKey();
    for (const key of keys.keys()) {
      const plainKey = key.slice(0, key.lastIndexOf('|') + 1);
      if (!/[一-鿿]/u.test(plainKey)) continue;
      byPlain.set(plainKey, [...(byPlain.get(plainKey) ?? []), key]);
    }
    const plainSource = (plainKey: string): AudioSource => {
      const [voice, plain] = plainKey.split('|');
      return { text: plain, voice: voice as VoiceId };
    };
    const homographs = [...byPlain.entries()].filter(([, full]) => full.length > 1);
    expect(homographs.length).toBeGreaterThan(0);
    const leaked: string[] = [];
    const shared: string[] = [];
    for (const [plainKey, full] of homographs) {
      if (await hasClip(plainSource(plainKey))) leaked.push(plainKey);
      const played = new Set<string | undefined>();
      for (const key of full) {
        const { job } = keys.get(key)!;
        played.add(idOf(await playedFile({ text: job.text, voice: job.voice })));
      }
      if (played.size !== full.length || played.has(undefined)) shared.push(full.join(' / '));
    }
    expect(leaked).toEqual([]);
    expect(shared).toEqual([]);

    // An unambiguous spelling is still found without its reading (callers that only have the kanji).
    const notFound: string[] = [];
    for (const [plainKey, full] of byPlain) {
      if (full.length === 1 && !(await hasClip(plainSource(plainKey)))) notFound.push(plainKey);
    }
    expect(notFound.slice(0, 20)).toEqual([]);
  }, 120_000);

  it('puts every clip in a pack that packsFor keeps warm at some point of the course', () => {
    const lastChapter = Math.max(...read<Curriculum>('curriculum.json').units.map((u) => u.chapter ?? 1));
    const warm = new Set(packsFor({ sprint: true, unit: 1, chapter: 1 }));
    for (let unit = 1; unit <= 25; unit++) for (const p of packsFor({ sprint: false, unit, chapter: 1 })) warm.add(p);
    for (let chapter = 1; chapter <= lastChapter; chapter++) for (const p of packsFor({ sprint: false, unit: 1, chapter })) warm.add(p);
    const cold = [...new Set(Object.values(manifest.clips).map((c) => c.pack))].filter((p) => !warm.has(p));
    expect(cold).toEqual([]);
    expect(manifest.credits).toEqual(['VOICEVOX:No.7', 'VOICEVOX:青山龍星']);
  });
});
