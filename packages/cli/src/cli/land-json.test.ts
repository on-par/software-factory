import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadFactoryConfig } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultOctokit } from './__fixtures__/land-octokit.js';
import { main } from './index.js';
import { landJsonSchema } from './land-contract.js';

const isolatedEnv = [
  'FACTORY_LOCAL_ONLY',
  'FACTORY_MERGE',
  'FACTORY_MERGE_ADMIN',
  'FACTORY_SKIP_CI',
  'FACTORY_RUN_CONFIG_JSON',
  'GITHUB_TOKEN',
];
const tmp = createTempDirs();
const stdout: string[] = [];
let repoRoot = '';

beforeEach(() => {
  repoRoot = tmp.makeSync('factory-land-json-');
  mkdirSync(join(repoRoot, '.git', 'info'), { recursive: true });
  mkdirSync(join(repoRoot, '.factory', 'state', 'plans'), { recursive: true });
  stdout.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void stdout.push(parts.join(' ')));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const key of isolatedEnv) vi.stubEnv(key, undefined);
  vi.stubEnv('GH_TOKEN', 'test-token');
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await tmp.cleanup();
});

async function runLand(ciOutcome: string, ...flags: string[]) {
  const octokit = defaultOctokit();
  const config = loadFactoryConfig();
  const exec = async (cmd: string) => {
    if (cmd.startsWith('gh repo view')) return { stdout: 'on-par/software-factory', stderr: '' };
    return { stdout: cmd.includes('rev-parse') ? repoRoot : '', stderr: '' };
  };
  await main(['node', 'factory', 'land', '5', ...flags], {
    octokit: () => octokit as never,
    exec,
    execSync: () => {
      throw new Error('no cli available');
    },
    watchChecks: async () => ciOutcome as never,
    setupWorktree: async () => undefined as never,
    cleanupWorktree: async () => undefined,
    gitFetch: async () => undefined,
    resolveSkipCI: () => false,
    loadFactoryConfigForRepo: () => ({ ...config, sandbox: { ...config.sandbox, enabled: false } }),
  });
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, last: stdout.at(-1) ?? '' };
}

describe('factory land --json', () => {
  it('prints a merged result line and exits 0 after a green land', async () => {
    const { code, last } = await runLand('success', '--json');
    expect(code).toBe(0);
    expect(landJsonSchema.parse(JSON.parse(last))).toEqual({
      result: 'merged',
      pr: 77,
      headSha: 'abc123',
      pending: [],
      mergeable: 'UNKNOWN',
      schemaVersion: 1,
    });
  });

  it('prints a checks_pending result line and exits 75 when the CI watch times out', async () => {
    const { code, last } = await runLand('timeout', '--json');
    expect(code).toBe(75);
    expect(JSON.parse(last)).toMatchObject({ result: 'checks_pending', pr: 77, headSha: 'abc123', pending: [] });
  });

  it('prints a checks_failed result line and keeps exit 0 on a failing check', async () => {
    const { code, last } = await runLand('failure', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(last)).toMatchObject({ result: 'checks_failed', pr: 77, failed: [] });
  });

  it('exits 75 on a CI timeout without --json and prints no JSON line', async () => {
    const { code, last } = await runLand('timeout');
    expect(code).toBe(75);
    expect(last).toContain('CI never reached a green verdict — left open, not merged');
    expect(stdout.some((line) => line.startsWith('{'))).toBe(false);
  });
});
