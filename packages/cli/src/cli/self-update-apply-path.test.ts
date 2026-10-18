import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySelfUpdate, prependPath } from './self-update-apply.js';

describe('prependPath (#3122)', () => {
  it('puts binDir first and keeps the rest in order', () => {
    expect(prependPath('/b', { PATH: ['/x', '/y'].join(delimiter) }).PATH).toBe(['/b', '/x', '/y'].join(delimiter));
  });

  it('yields just binDir for an undefined or empty PATH', () => {
    expect(prependPath('/b', {}).PATH).toBe('/b');
    expect(prependPath('/b', { PATH: '' }).PATH).toBe('/b');
  });

  it('moves an existing binDir entry to the front without duplicating it', () => {
    expect(prependPath('/b', { PATH: ['/x', '/b', '/y'].join(delimiter) }).PATH).toBe(
      ['/b', '/x', '/y'].join(delimiter),
    );
  });

  it('passes other env keys through and does not mutate the input', () => {
    const env = { PATH: '/x', HOME: '/h' };
    const out = prependPath('/b', env);
    expect(out.HOME).toBe('/h');
    expect(env).toEqual({ PATH: '/x', HOME: '/h' });
  });
});

const tmp = createTempDirs();

describe('production seams', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp.makeSync('self-update-apply-path-');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    tmp.cleanup();
  });

  it('the default exec puts the install bin dir first on PATH so an env-node npm passes preflight when PATH lacks node (#3122)', async () => {
    const prefix = join(dir, 'prefix');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'empty'));
    symlinkSync(process.execPath, join(prefix, 'bin', 'node'));
    const npm = join(prefix, 'bin', 'npm');
    writeFileSync(npm, '#!/usr/bin/env node\nconsole.log("11.0.0")\n');
    chmodSync(npm, 0o755);
    const install = {
      version: '0.9.0',
      env: {},
      execPath: join(prefix, 'bin', 'node'),
      cliPath: join(prefix, 'lib', 'node_modules', '@on-par', 'factory-cli', 'dist', 'cli.js'),
      exists: () => false,
    };
    vi.stubEnv('PATH', join(dir, 'empty'));
    const out = await applySelfUpdate({ to: '0.9.1', dryRun: true, force: true }, { install });
    expect(out.code).toBe(0);
    expect(out.result.outcome).toBe('dry-run');
    expect(out.result.steps[0]).toMatchObject({ step: 'preflight', ok: true });
  });
});
