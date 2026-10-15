// Small per-device memories for the together screens (what was read, which
// role-plays were done, the last quizzes seen). localStorage can be missing or
// throw (private mode, blocked storage), so every access is guarded and the
// screens still work without it.

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: the memory just won't survive a reload */ }
}

export const STORAGE_KEYS = {
  chatLastRead: 'issho.chat.lastRead.v1',
  chatFurigana: 'issho.chat.furigana.v1',
  rolePlayHistory: 'issho.roleplay.history.v1',
  quizzes: 'issho.quizzes.v1',
  quizResults: 'issho.quizResults.v1',
  rulesShown: 'issho.together.rulesShown.v1',
} as const;

// ---- Chat ------------------------------------------------------------------

/** Server id of the newest message seen in the chat screen (0 = none). */
export function lastReadMessageId(): number {
  const id = readJson<unknown>(STORAGE_KEYS.chatLastRead, 0);
  return typeof id === 'number' && Number.isFinite(id) ? id : 0;
}

export function markMessagesRead(id: number): void {
  if (id > lastReadMessageId()) writeJson(STORAGE_KEYS.chatLastRead, id);
}

// ---- Role-plays ------------------------------------------------------------

/** When each role-play was last finished on this phone (ms epoch by script id). */
export function rolePlayHistory(): Record<string, number> {
  const history = readJson<unknown>(STORAGE_KEYS.rolePlayHistory, {});
  return history && typeof history === 'object' ? (history as Record<string, number>) : {};
}

export function recordRolePlayDone(scriptId: string, at: number = Date.now()): void {
  writeJson(STORAGE_KEYS.rolePlayHistory, { ...rolePlayHistory(), [scriptId]: at });
}
