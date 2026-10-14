// Voice message audio for playback. Server audio needs the bearer token, so it is
// fetched as a Blob and played from an object URL. A small in-memory cache keeps
// recently played clips (and clips this device just sent) around.

import { useEffect, useRef, useState } from 'react';
import { fetchVoice } from './client.ts';

const MAX_CACHED = 30;
const cache = new Map<string, Promise<Blob>>();

function remember(audioId: string, blob: Promise<Blob>) {
  cache.delete(audioId);
  cache.set(audioId, blob);
  // Map iteration order is insertion order, so the first key is the least recently used.
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/** Seeds the cache with audio this device recorded, so it plays without a download. */
export function rememberVoice(audioId: string, blob: Blob): void {
  remember(audioId, Promise.resolve(blob));
}

export function loadVoice(audioId: string): Promise<Blob> {
  const hit = cache.get(audioId);
  if (hit) {
    remember(audioId, hit);
    return hit;
  }
  const p = fetchVoice(audioId);
  p.catch(() => cache.delete(audioId));
  remember(audioId, p);
  return p;
}

/**
 * An object URL for a voice message: the local recording while it is still in the
 * outbox, otherwise the server copy. The URL is revoked on unmount.
 */
export function useVoiceUrl(audioId?: string, local?: Blob): { url?: string; error: boolean } {
  const [state, setState] = useState<{ url?: string; error: boolean }>({ error: false });
  // Every IndexedDB read returns a new Blob object for the same stored recording, and
  // the chat list re-reads whenever the outbox or messages change. Keying on the blob
  // object would swap the URL (cutting off playback) each time, so key on its shape.
  const localKey = local ? `${local.size}:${local.type}` : '';
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    const show = (blob: Blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setState({ url, error: false });
    };
    setState({ error: false });
    const blob = localRef.current;
    if (blob) show(blob);
    else if (audioId) loadVoice(audioId).then(show, () => { if (!cancelled) setState({ error: true }); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [audioId, localKey]);
  return state;
}
