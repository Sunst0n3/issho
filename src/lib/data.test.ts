import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanaExamplesFile } from './data.ts';

const EXAMPLES: KanaExamplesFile = {
  け: { kana: 'いけ', written: '池', en: 'pond' },
  ア: { kana: 'アイス', en: 'ice cream' },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The loaders memoize per page, so each test gets a fresh copy of the module.
const freshData = async () => {
  vi.resetModules();
  return import('./data.ts');
};

describe('loadKanaExamples', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads content/kana-examples.json from the static data', async () => {
    fetchMock.mockResolvedValue(json(EXAMPLES));
    const { loadKanaExamples } = await freshData();
    await expect(loadKanaExamples()).resolves.toEqual(EXAMPLES);
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}data/content/kana-examples.json`);
  });

  it('fetches once for the life of the page', async () => {
    fetchMock.mockResolvedValue(json(EXAMPLES));
    const { loadKanaExamples } = await freshData();
    await loadKanaExamples();
    expect((await loadKanaExamples())['け']).toEqual({ kana: 'いけ', written: '池', en: 'pond' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the file is missing and tries again on the next call', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(EXAMPLES));
    const { loadKanaExamples } = await freshData();
    await expect(loadKanaExamples()).rejects.toThrow(`Could not load ${import.meta.env.BASE_URL}data/content/kana-examples.json (404)`);
    await expect(loadKanaExamples()).resolves.toEqual(EXAMPLES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('optional content', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads as empty when the file is not built yet (404 or the HTML fallback page)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const { loadStories, loadUnits, loadAudioManifest, EMPTY_MANIFEST } = await freshData();
    await expect(loadStories()).resolves.toEqual([]);
    await expect(loadUnits()).resolves.toEqual([]);
    await expect(loadAudioManifest()).resolves.toEqual(EMPTY_MANIFEST);
    expect(fetchMock).toHaveBeenLastCalledWith(`${import.meta.env.BASE_URL}audio/manifest.json`);
  });

  it('still fails on a server error', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } }));
    const { loadAccent } = await freshData();
    await expect(loadAccent()).rejects.toThrow('(500)');
  });
});

describe('loadWordInfo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves core and JMdict refs to one shape', async () => {
    const core = [{ id: 'cw-0040', order: 40, kana: 'げんき', written: '元気', en: 'well', pos: 'adj-na', register: 'both', topic: 't', use: true, kanji: ['元', '気'], unit: 1, altKana: ['げんき'] }];
    const words = [{ id: '1002', written: '日本', kana: 'にほん', meanings: ['Japan', 'Nippon'], pos: ['n'], freqRank: 1, kanji: ['日', '本'], altKana: ['にっぽん'] }];
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(json(url.endsWith('core-words.json') ? core : words))));
    const { loadWordInfo } = await freshData();
    const info = await loadWordInfo();
    expect(info('core:cw-0040')).toMatchObject({ ref: 'core:cw-0040', written: '元気', kana: 'げんき', use: true, readings: ['げんき', 'げんき'], register: 'both' });
    expect(info('word:1002')).toMatchObject({ ref: 'word:1002', written: '日本', en: 'Japan; Nippon', use: false, readings: ['にほん', 'にっぽん'] });
    expect(info('word:9')).toBeUndefined();
  });
});
