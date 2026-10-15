import 'fake-indexeddb/auto';

// Node 25 ships a global localStorage stub (without --localstorage-file) that hides
// jsdom's. Give every test a working in-memory Storage instead.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true });
}

// jsdom has no media playback: play(), pause() and load() only log "not implemented".
// play() resolves and 'ended' follows after a microtask, so code that waits for the end of a
// clip finishes; pause() and load() do nothing. Tests that need a clip to keep playing spy on
// play() themselves.
if (typeof HTMLMediaElement !== 'undefined') {
  const media = HTMLMediaElement.prototype;
  Object.defineProperty(media, 'play', {
    configurable: true,
    writable: true,
    value: function play(this: HTMLMediaElement): Promise<void> {
      queueMicrotask(() => this.dispatchEvent(new Event('ended')));
      return Promise.resolve();
    },
  });
  for (const name of ['pause', 'load'] as const) {
    Object.defineProperty(media, name, { configurable: true, writable: true, value: function noop() {} });
  }
}

// Blob URLs for audio playback (jsdom has no createObjectURL).
if (typeof URL.createObjectURL !== 'function') {
  let next = 0;
  URL.createObjectURL = () => `blob:test/${++next}`;
}
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};

// No Cache Storage, like old browsers and plain-http pages: audio code must cope without it.
// Tests that exercise caching stub `caches` themselves.
delete (globalThis as { caches?: unknown }).caches;
