// The Docker image (TECH-DESIGN §3.5.4) can't be built in the tests, so these check the files it
// is built from against what the app needs: the web stage's type check reaches the server's code
// through the integration tests' in-process server (test-server.ts), and the speech engine must be
// the version the voice clips were made with.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** The app's sources (what `tsc --noEmit` in `npm run build` type-checks) that import the server's code. */
function importersOfServer(dir = path.join(root, 'src')): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...importersOfServer(file));
    else if (/\.tsx?$/.test(entry.name) && /from '(\.\.\/)+server\/src\//.test(readFileSync(file, 'utf8'))) {
      found.push(path.relative(root, file));
    }
  }
  return found;
}

describe('Dockerfile', () => {
  it("installs the server's packages in the web stage before `npm run build` when the app's type check reaches server/src", () => {
    // Today that is the integration tests' in-process server; without any, the install isn't needed.
    if (!importersOfServer().length) return;
    const stage = /^FROM \S+ AS web\n([\s\S]*?)^FROM /m.exec(read('Dockerfile'))?.[1] ?? '';
    const web = stage.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    const copyLock = web.indexOf('COPY server/package.json server/package-lock.json');
    const install = web.indexOf('npm ci --prefix server');
    const build = web.indexOf('npm run build');
    expect(copyLock).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(copyLock);
    expect(build).toBeGreaterThan(install);
    // The build context keeps what that install needs.
    const ignored = read('.dockerignore').split('\n').map((l) => l.trim());
    for (const file of ['server', 'server/package.json', 'server/package-lock.json', 'server/src']) {
      expect(ignored, file).not.toContain(file);
    }
  });
});

describe('docker-compose.yml', () => {
  it('runs the VOICEVOX engine version the voice clips were made with, with a healthcheck', () => {
    const engine = (JSON.parse(read('public/audio/manifest.json')) as { engine?: string }).engine ?? '';
    const version = /^VOICEVOX (\d+\.\d+\.\d+)$/.exec(engine)?.[1];
    expect(version, engine).toBeDefined();
    const voicevox = /^ {2}voicevox:\n((?: {4}.*\n|\s*\n)+)/m.exec(read('docker-compose.yml'))?.[1] ?? '';
    expect(voicevox).toMatch(new RegExp(`^ {4}image: voicevox/voicevox_engine:cpu-${version!.replace(/\./g, '\\.')}$`, 'm'));
    expect(voicevox).toMatch(/^ {4}healthcheck:\n {6}test: .*\/version/m);
  });
});
