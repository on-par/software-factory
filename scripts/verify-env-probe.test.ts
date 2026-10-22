import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../packages/core/src/harness/temp-dir.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const tempDirs = createTempDirs();
afterAll(() => tempDirs.cleanup());

function stub(dir: string, name: string, body: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/** A temp repo holding verify.sh and the probe, with stub `node` and `npm` first on PATH. */
function fixture(nodeBody: string, npmBody: string) {
  const root = tempDirs.makeSync('verify-env-probe-');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  for (const f of ['verify.sh', 'verify-env-probe.mjs'])
    copyFileSync(join(REPO_ROOT, 'scripts', f), join(root, 'scripts', f));
  const calls = join(root, 'npm-calls');
  stub(join(root, 'bin'), 'node', nodeBody);
  stub(join(root, 'bin'), 'npm', `echo "$@" >> "${calls}"\n${npmBody}`);
  const r = spawnSync('bash', [join(root, 'scripts/verify.sh'), '--no-e2e'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  });
  return { r, calls };
}

describe('verify.sh environment probe (#3332)', () => {
  it('verify.sh prints the EPERM marker, runs no npm step and exits 78 when the loopback probe is denied', () => {
    const { r, calls } = fixture(
      'echo "EPERM: tcp 127.0.0.1: listen EPERM: operation not permitted 127.0.0.1"\nexit 78',
      'exit 0',
    );
    expect(r.status).toBe(78);
    expect(r.stdout).toContain('verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)');
    expect(r.stdout).toContain('verify: EPERM: tcp 127.0.0.1');
    expect(existsSync(calls)).toBe(false);
  });

  it('falls through to npm ci when the probe passes', () => {
    const { r, calls } = fixture('exit 0', 'exit 1');
    expect(r.status).not.toBe(78);
    expect(readFileSync(calls, 'utf8')).toContain('ci');
  });

  it('falls through when the probe fails with an exit other than 78', () => {
    const { r, calls } = fixture('exit 3', 'exit 1');
    expect(r.status).not.toBe(78);
    expect(readFileSync(calls, 'utf8')).toContain('ci');
  });

  it('the real probe passes on a host that allows loopback binds', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/verify-env-probe.mjs')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});
