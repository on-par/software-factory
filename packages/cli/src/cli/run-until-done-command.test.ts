import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import './index.js';
import { setShipRuntime, shipRuntime } from './ship-runtime.js';
import { cmdRunUntilDone, cmdRunUntilDoneWith } from './run-until-done-command.js';

const neverCalled = (): string => {
  throw new Error('branchPrefixOrExit must not run before the flags validate');
};

describe('cmdRunUntilDone', () => {
  it.each([
    ['an unknown --wait mode', { wait: 'forever' }],
    ['--local-queue', { localQueue: true }],
    ['--max-lanes', { maxLanes: '2' }],
    ['a bad --max-wait', { maxWait: 'soon' }],
  ])('exits 2 for %s before touching the repo', async (_name, opts) => {
    const err = await cmdRunUntilDone(12, opts, neverCalled).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect(err).toMatchObject({ code: 2 });
  });
});

describe('cmdRunUntilDoneWith', () => {
  it('binds the branch-prefix resolver into the handler', async () => {
    const handler = cmdRunUntilDoneWith(neverCalled);
    await expect(handler(12, { wait: 'forever' })).rejects.toMatchObject({ code: 2 });
  });
});

const closedPull = (mergedAt: string | null) => ({
  number: 7,
  state: 'closed',
  merged_at: mergedAt,
  head: { ref: 'factory/12-x', repo: { full_name: 'o/r' } },
});

describe('cmdRunUntilDone end to end against a finished PR', () => {
  const real = shipRuntime();
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'until-done-cmd-'));
    mkdirSync(join(root, '.factory'), { recursive: true });
  });
  afterEach(() => {
    setShipRuntime(() => real);
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function useGitHubWith(pull: ReturnType<typeof closedPull>): void {
    const octokit = new Octokit({
      request: {
        fetch: async () =>
          new Response(JSON.stringify([pull]), { status: 200, headers: { 'content-type': 'application/json' } }),
      },
    });
    setShipRuntime(() => ({
      ...real,
      resolveCoreOps: (o) => ({ ...real.resolveCoreOps(o), isCommandAvailable: () => true }),
      getRepoRoot: async () => root,
      getGitHubRepo: async () => 'o/r',
      getOctokit: () => octokit,
    }));
  }

  it('exits 2 when no agent CLI is available', async () => {
    useGitHubWith(closedPull(null));
    setShipRuntime(() => ({
      ...real,
      resolveCoreOps: (o) => ({ ...real.resolveCoreOps(o), isCommandAvailable: () => false }),
    }));
    await expect(cmdRunUntilDone(12, {}, () => 'factory')).rejects.toMatchObject({ code: 2 });
  });

  it('exits 2 when the repo is not initialized', async () => {
    useGitHubWith(closedPull(null));
    rmSync(join(root, '.factory'), { recursive: true, force: true });
    await expect(cmdRunUntilDone(12, {}, () => 'factory')).rejects.toMatchObject({ code: 2 });
  });

  it('an already merged PR exits 0 without shipping', async () => {
    useGitHubWith(closedPull('2026-01-01T00:00:00Z'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(cmdRunUntilDone(12, { wait: 'exit' }, () => 'factory')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('merged PR #7'));
  });

  it('a PR closed without merging exits 15 and --json reports closed', async () => {
    useGitHubWith(closedPull(null));
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    await expect(cmdRunUntilDone(12, { json: true }, () => 'factory')).rejects.toMatchObject({ code: 15 });
    const result = JSON.parse(out.at(-1) ?? '{}');
    expect(result).toMatchObject({ outcome: 'closed', pr: { number: 7, state: 'closed' } });
  });
});
