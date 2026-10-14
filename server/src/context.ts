import type { AiService } from './ai.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { Hub } from './hub.ts';
import type { RateLimiter } from './rate-limit.ts';

/** Everything a route needs, built once in buildApp(). */
export interface AppContext {
  config: Config;
  store: Store;
  hub: Hub;
  /** null when ANTHROPIC_API_KEY is not set. */
  ai: AiService | null;
  now: () => Date;
  /** Read on every request: the admin CLI can change it while the server runs. */
  householdName: () => string;
  voiceDir: string;
  version: string;
  limits: {
    register: RateLimiter;
    ai: RateLimiter;
  };
}
