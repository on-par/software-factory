// packages/cli/src/cli/run-issue-stack-flags.test.ts — `factory run-issue --stack` flag handling (#3798)
import { describe, expect, it } from 'vitest';

import { errored, h, installShipHarness, logged, runMainWith, setupWorktree } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('run-issue --stack (#3798)', () => {
  it('--stack --no-pr exits 2 with a one-line error', async () => {
    const res = await runMain('run-issue', '5', '--stack', '--no-pr');

    expect(res).toEqual({ exited: true, code: 2 });
    const msg = errored()
      .split('\n')
      .find((l) => l.includes('--stack opens a PR per slice'));
    expect(msg).toBe('factory: --stack opens a PR per slice — drop --no-pr or drop --stack');
  });

  it('--stack and --size-gate stack both refuse --no-pr with the same error', async () => {
    const a = await runMain('run-issue', '5', '--stack', '--no-pr');
    const first = errored();
    const b = await runMain('run-issue', '5', '--size-gate', 'stack', '--no-pr');

    expect(a.code).toBe(2);
    expect(b).toEqual({ exited: true, code: 2 });
    expect(errored().replace(first, '')).toContain('--stack opens a PR per slice');
  });

  it('--stack --size-gate file exits 2', async () => {
    const res = await runMain('run-issue', '5', '--stack', '--size-gate', 'file');

    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--stack is --size-gate stack');
  });

  it('--stack runs the stack path', async () => {
    h.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const res = await runMain('run-issue', '5', '--stack');

    expect(res.exited).toBe(false);
    expect(logged()).toContain('run-issue: --stack — sizing #5');
  });

  it('--stack --base-branch starts the first run from origin/<base>', async () => {
    h.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const res = await runMain('run-issue', '5', '--stack', '--base-branch', 'feat/x');

    expect(res.exited).toBe(false);
    expect(setupWorktree.mock.calls[0]?.[3]).toBe('origin/feat/x');
  });
});
