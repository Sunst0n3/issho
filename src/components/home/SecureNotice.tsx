// Today and Settings: a warning when the app is opened from an address the
// browser doesn't treat as secure (plain http:// on the home network), where
// offline use, voice recording and persistent storage are all switched off.
import { secureContextProblem } from '../../sync/client.ts';
import { Icon } from '../ui.tsx';

export function SecureNotice() {
  const problem = secureContextProblem();
  if (!problem) return null;
  return (
    <section className="hm-warning" aria-labelledby="hm-secure-title">
      <h2 id="hm-secure-title" className="hm-warning-title">
        <Icon name="cloudOff" size={18} />Issho can't work offline from this address
      </h2>
      <p>{problem}</p>
    </section>
  );
}

/** Whether the "works offline" promise holds on this address. */
export function worksOffline(): boolean {
  return secureContextProblem() === null;
}
