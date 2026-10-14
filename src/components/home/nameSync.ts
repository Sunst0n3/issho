// Keeps this phone's member name on the home server in step with the name in
// Settings, so the partner sees the new name and reconnecting doesn't create a
// second member under it.
import { renameMember } from '../../sync/client.ts';
import { refreshHousehold } from '../../sync/stats.ts';

/** The name last sent (or being sent) to the server, so the same rename isn't sent twice. */
let sent: string | undefined;

/**
 * Renames this phone's member on the home server. Failures are silent: the
 * next save, or the next time Settings sees the server with the old name,
 * tries again.
 */
export function syncMemberName(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean || clean === sent) return Promise.resolve();
  sent = clean;
  return renameMember(clean).then(
    () => refreshHousehold(),
    () => { if (sent === clean) sent = undefined; },
  );
}

/** For tests. */
export function resetNameSync(): void {
  sent = undefined;
}
