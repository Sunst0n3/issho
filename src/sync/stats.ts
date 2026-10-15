// Sharing study progress with the household: uploads this member's recent days
// and totals, and keeps the latest household view (both members) for the
// Together screen, cached in localStorage so it still shows offline.

import { useEffect, useSyncExternalStore } from 'react';
import type { HouseholdResponse, StatsUploadRequest } from '../../shared/api.ts';
import { db, getSettings } from '../lib/db.ts';
import { streak } from '../srs/habits.ts';
import { memberProgress } from '../srs/memberProgress.ts';
import { knownKanji, weekStats } from '../srs/progress.ts';
import { ApiError, getHousehold, isPaired, isPairedSettings, uploadStats } from './client.ts';
import { onServerEvent, onStatusChange } from './socket.ts';
import { buildStatsPayload } from './statsPayload.ts';

export { buildStatsPayload } from './statsPayload.ts';

/** Long enough that a review session uploads once at the end, not after every card. */
const PUSH_DEBOUNCE_MS = 15_000;
/** useHousehold() refetches on mount when the data is older than this. */
const HOUSEHOLD_STALE_MS = 60_000;
/** v2: the household view gained the couple quest; a cached v1 view is dropped. */
const CACHE_KEY = 'issho.household.v2';
const OLD_CACHE_KEYS = ['issho.household.v1'];

// ---- Upload ----------------------------------------------------------------

/** Rest-token dates from `first` to `last` (inclusive). */
async function restTokenDates(first: string, last: string): Promise<Set<string>> {
  const tokens = await db.restTokens.where('date').between(first, last, true, true).toArray();
  return new Set(tokens.map((t) => t.date));
}

/** This member's stats as uploaded: the last 14 days, streak, known kanji and the progress summary. */
export async function collectStats(now: Date = new Date()): Promise<StatsUploadRequest> {
  const [days, streakInfo, kanji, progress, settings] = await Promise.all([
    weekStats(now),
    streak(now),
    knownKanji(),
    memberProgress(now),
    getSettings(),
  ]);
  const dates = days.map((d) => d.date).sort();
  const tokens = dates.length ? await restTokenDates(dates[0], dates[dates.length - 1]) : new Set<string>();
  return buildStatsPayload({
    days,
    tokens,
    streak: streakInfo.current,
    knownKanji: kanji,
    progress,
    shareAccuracy: settings.shareAccuracy,
  });
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pushImmediate = false;
let pushWaiters: Array<(ok: boolean) => void> = [];

async function runPush() {
  pushTimer = undefined;
  pushImmediate = false;
  const waiters = pushWaiters;
  pushWaiters = [];
  let ok = false;
  try {
    if (await isPaired()) {
      await uploadStats(await collectStats());
      ok = true;
      void refreshHousehold();
    }
  } catch (e) {
    // Being offline is normal; the next push (on reconnect or after studying) catches up.
    if (!(e instanceof ApiError && e.transient)) console.warn('stats upload failed', e);
  }
  for (const resolve of waiters) resolve(ok);
}

/**
 * Uploads this member's stats, debounced so a burst of calls (every graded card,
 * session end, app start) makes one request. Pass `immediate` after finishing a
 * session so the partner sees it right away. Resolves true once uploaded; false
 * when unpaired or the server could not be reached.
 */
export function pushStats({ immediate = false }: { immediate?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    pushWaiters.push(resolve);
    // A later debounced call must not postpone an upload that was asked for right away.
    if (pushTimer !== undefined && pushImmediate) return;
    clearTimeout(pushTimer);
    pushImmediate = immediate;
    pushTimer = setTimeout(() => void runPush(), immediate ? 0 : PUSH_DEBOUNCE_MS);
  });
}

/** Sends a pending debounced upload now (e.g. as the app goes to the background). */
export function flushPendingStats(): void {
  if (pushTimer === undefined) return;
  clearTimeout(pushTimer);
  void runPush();
}

// ---- Household view --------------------------------------------------------

export interface HouseholdState {
  data?: HouseholdResponse;
  /** When `data` was fetched (ms epoch); from the cache when offline. */
  fetchedAt?: number;
  loading: boolean;
  error?: ApiError;
}

function readCache(): Pick<HouseholdState, 'data' | 'fetchedAt'> {
  try {
    for (const key of OLD_CACHE_KEYS) localStorage.removeItem(key);
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { data?: HouseholdResponse; fetchedAt?: number };
    return parsed.data && Array.isArray(parsed.data.members) ? { data: parsed.data, fetchedAt: parsed.fetchedAt } : {};
  } catch {
    return {};
  }
}

function writeCache(data: HouseholdResponse | undefined, fetchedAt?: number) {
  try {
    if (data) localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt }));
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* storage unavailable (private mode): the view just won't survive a reload */ }
}

let household: HouseholdState = { loading: false, ...readCache() };
const householdListeners = new Set<() => void>();
let householdRequest: Promise<void> | null = null;

function setHousehold(patch: Partial<HouseholdState>) {
  household = { ...household, ...patch };
  for (const cb of [...householdListeners]) cb();
}

/** Fetches /api/household now (shared with any request already in flight). */
export function refreshHousehold(): Promise<void> {
  householdRequest ??= (async () => {
    if (!isPairedSettings(await getSettings())) {
      resetHousehold();
      return;
    }
    setHousehold({ loading: true });
    try {
      const data = await getHousehold();
      const fetchedAt = Date.now();
      writeCache(data, fetchedAt);
      setHousehold({ data, fetchedAt, loading: false, error: undefined });
    } catch (e) {
      setHousehold({ loading: false, error: e instanceof ApiError ? e : new ApiError(0, 'network', String(e)) });
    }
  })().finally(() => { householdRequest = null; });
  return householdRequest;
}

/** Forgets the household view (after unpairing or pairing elsewhere). */
export function resetHousehold() {
  writeCache(undefined);
  setHousehold({ data: undefined, fetchedAt: undefined, error: undefined, loading: false });
}

function subscribeHousehold(cb: () => void) {
  householdListeners.add(cb);
  return () => { householdListeners.delete(cb); };
}

const getHouseholdState = () => household;

/** The household (both members' stats, the couple quest). Works offline from the last cached copy. */
export function useHousehold(): HouseholdState & { refresh: () => Promise<void> } {
  const state = useSyncExternalStore(subscribeHousehold, getHouseholdState, getHouseholdState);
  useEffect(() => {
    if (!household.fetchedAt || Date.now() - household.fetchedAt > HOUSEHOLD_STALE_MS) void refreshHousehold();
  }, []);
  return { ...state, refresh: refreshHousehold };
}

/** Refreshes the household view on 'stats' events and whenever the socket reconnects. */
export function startHousehold(): () => void {
  const offEvents = onServerEvent((ev) => {
    if (ev.type === 'stats') void refreshHousehold();
  });
  const offStatus = onStatusChange((s) => {
    if (s === 'online') void refreshHousehold();
  });
  return () => {
    offEvents();
    offStatus();
  };
}
