// packages/cli/src/cli/run-issue-stack-flags.test.ts — `factory run-issue --stack` flag handling (#3798)
import { describe, expect, it, vi } from 'vitest';

import type { CliDeps } from './index.js';
import { errored, h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

type PlanOpts = Parameters<NonNullable<CliDeps['planPhase']>>[0];

function recordPlans() {
  const planOpts: PlanOpts[] = [];
  const deps: CliDeps = {
    planPhase: async (o) => {
      planOpts.push(o);
      return h.planResult;
    },
  };
  return { planOpts, deps };
}

function recordStarts() {
  const starts: Array<string | undefined> = [];
  h.setupWorktreeImpl = async (_r, _b, _w, start) => {
    starts.push(start);
  };
  return starts;
}

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

  it('--stack --size-gate off exits 2', async () => {
    const res = await runMain('run-issue', '5', '--stack', '--size-gate', 'off');

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
    const r = recordPlans();
    await runMainWith(r.deps, 'run-issue', '5', '--size-gate', 'stack');
    const call = r.planOpts.at(-1);
    expect(call?.sizeGateMode).toBe('stack');
    expect(call?.enforceSizeGate).toBe(true);
  });

  it('resolves and builds each prerequisite with the bounded stack gate', async () => {
    h.octokit.request = vi.fn(async (_route: string, params: { issue_number: number }) => ({
      data: params.issue_number === 5 ? [{ number: 4, state: 'open', repository: { full_name: h.ghRepo } }] : [],
    }));
    const fetched: number[] = [];
    h.octokit.rest.issues.get.mockImplementation(async ({ issue_number }: { issue_number: number }) => {
      fetched.push(issue_number);
      return {
        data: { title: `Issue ${issue_number}`, body: `Work ${issue_number}` },
      };
    });
    const r = recordPlans();
    const starts = recordStarts();
    const result = await runMainWith(r.deps, 'run-issue', '5', '--stack', '--base-branch', 'main');
    expect(result.exited).toBe(false);
    expect(fetched).toEqual(expect.arrayContaining([4, 5]));
    expect(r.planOpts.map((o) => o.parkOverBudget)).toEqual([true, true]);
    expect(starts[0]).toBe('origin/main');
    expect(starts[1]).toContain('origin/');
  });

  it('parks an over-budget chain member and skips later issues', async () => {
    h.octokit.request = vi.fn(async (_route: string, params: { issue_number: number }) => ({
      data: params.issue_number === 5 ? [{ number: 4, state: 'open' }] : [],
    }));
    h.planResult = { ok: false, route: 'claude', escalate: 'plan scope exceeds the bounded-build budget' };
    const r = recordPlans();
    const result = await runMainWith(r.deps, 'run-issue', '5', '--size-gate', 'stack');
    expect(result.code).toBe(1);
    expect(r.planOpts).toHaveLength(1);
    expect(r.planOpts[0]?.parkOverBudget).toBe(true);
    expect(logged()).toContain('issue #5 skipped');
  });

  it('--stack --base-branch starts the first run from origin/<base>', async () => {
    h.octokit.request = vi.fn().mockResolvedValue({ data: [] });
    h.octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const starts = recordStarts();
    const res = await runMain('run-issue', '5', '--stack', '--base-branch', 'feat/x');

    expect(res.exited).toBe(false);
    expect(starts[0]).toBe('origin/feat/x');
  });
});
