// packages/cli/src/cli/run-issue-stack-flags.test.ts — `factory run-issue --stack` flag handling (#3798)
import { describe, expect, it, vi } from 'vitest';

import {
  errored,
  h,
  installShipHarness,
  logged,
  phases,
  runMainWith,
  setupWorktree,
} from './test-support/ship-harness.js';

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
    h.octokit.request = vi.fn().mockResolvedValue({ data: [] });
    h.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const res = await runMain('run-issue', '5', '--stack');

    expect(res.exited).toBe(false);
    expect(logged()).toContain('run-issue: --stack — sizing #5');
  });

  it('--size-gate stack passes sizeGateMode stack to planPhase', async () => {
    h.octokit.request = vi.fn().mockResolvedValue({ data: [] });
    await runMain('run-issue', '5', '--size-gate', 'stack');
    const call = phases.planPhase.mock.calls.at(-1)?.[0];
    expect(call?.sizeGateMode).toBe('stack');
    expect(call?.enforceSizeGate).toBe(true);
  });

  it('resolves and builds each prerequisite with the bounded stack gate', async () => {
    h.octokit.request = vi.fn(async (_route: string, params: { issue_number: number }) => ({
      data: params.issue_number === 5 ? [{ number: 4, state: 'open', repository: { full_name: h.ghRepo } }] : [],
    }));
    h.octokit.rest.issues.get.mockImplementation(async ({ issue_number }: { issue_number: number }) => ({
      data: { title: `Issue ${issue_number}`, body: `Work ${issue_number}` },
    }));
    const result = await runMain('run-issue', '5', '--stack', '--base-branch', 'main');
    expect(result.exited).toBe(false);
    expect(
      h.octokit.rest.issues.get.mock.calls.map((call: [{ issue_number: number }]) => call[0].issue_number),
    ).toEqual(expect.arrayContaining([4, 5]));
    expect(phases.planPhase.mock.calls.map(([opts]) => opts.parkOverBudget)).toEqual([true, true]);
    expect(setupWorktree.mock.calls[0]?.[3]).toBe('origin/main');
    expect(setupWorktree.mock.calls[1]?.[3]).toContain('origin/');
  });

  it('parks an over-budget chain member and skips later issues', async () => {
    h.octokit.request = vi.fn(async (_route: string, params: { issue_number: number }) => ({
      data: params.issue_number === 5 ? [{ number: 4, state: 'open' }] : [],
    }));
    h.planResult = { ok: false, route: 'claude', escalate: 'plan scope exceeds the bounded-build budget' };
    const result = await runMain('run-issue', '5', '--size-gate', 'stack');
    expect(result.code).toBe(1);
    expect(phases.planPhase).toHaveBeenCalledTimes(1);
    expect(phases.planPhase.mock.calls[0]?.[0].parkOverBudget).toBe(true);
    expect(logged()).toContain('issue #5 skipped');
  });

  it('--stack --base-branch starts the first run from origin/<base>', async () => {
    h.octokit.request = vi.fn().mockResolvedValue({ data: [] });
    h.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const res = await runMain('run-issue', '5', '--stack', '--base-branch', 'feat/x');

    expect(res.exited).toBe(false);
    expect(setupWorktree.mock.calls[0]?.[3]).toBe('origin/feat/x');
  });
});
