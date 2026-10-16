import { accessSync, constants, mkdirSync } from 'node:fs';
import { createAnthropicAi, createOllamaAi } from './ai.ts';
import { buildApp, loggerOptions } from './app.ts';
import { ConfigError, dataPaths, loadConfig, type Config } from './config.ts';
import { Store } from './db.ts';
import { createVoicevoxTts } from './tts.ts';

/** Below Docker's default 10 s stop timeout, so we exit on our own terms before SIGKILL. */
const SHUTDOWN_TIMEOUT_MS = 8000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) fail(error.message);
  throw error;
}

try {
  mkdirSync(config.dataDir, { recursive: true });
  accessSync(config.dataDir, constants.W_OK);
} catch {
  fail(
    `DATA_DIR ${config.dataDir} is not writable by this user (uid ${process.getuid?.() ?? '?'}). ` +
      'With Docker, create the folder and give it to uid 1000: mkdir -p issho-data && sudo chown 1000:1000 issho-data',
  );
}

const store = new Store(dataPaths(config.dataDir).database);
const ai = config.aiProvider === 'ollama'
  ? createOllamaAi({ baseUrl: config.aiBaseUrl, model: config.aiModel })
  : config.aiProvider === 'anthropic' && config.anthropicApiKey
    ? createAnthropicAi({ apiKey: config.anthropicApiKey, model: config.aiModel })
    : null;
const tts = config.voicevoxUrl
  ? createVoicevoxTts({ baseUrl: config.voicevoxUrl, cacheDir: dataPaths(config.dataDir).tts, maxCacheMb: config.ttsCacheMb })
  : null;
const app = await buildApp({ config, store, ai, tts, logger: loggerOptions(config.logLevel) });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    app.log.error('shutdown timed out; exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await app.close();
    store.close();
    app.log.info('stopped');
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exitCode = 1;
  }
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.fatal({ err: error }, 'could not start the server');
  store.close();
  process.exit(1);
}

if (config.householdCode.length < 8) {
  app.log.warn('HOUSEHOLD_CODE is shorter than 8 characters; anyone who guesses it can join');
}
app.log.info(
  {
    household: store.householdName() ?? config.householdName,
    aiEnabled: ai !== null,
    aiProvider: config.aiProvider,
    model: ai ? config.aiModel : undefined,
    // The engine may still be starting (its image warms up for a while); /api/health follows it.
    tts: tts ? config.voicevoxUrl : 'off',
  },
  'issho server ready',
);
