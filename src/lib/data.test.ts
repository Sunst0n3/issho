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
    await expect(loadKanaExamples()).rejects.toThrow('Could not load content/kana-examples.json (404)');
    await expect(loadKanaExamples()).resolves.toEqual(EXAMPLES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
