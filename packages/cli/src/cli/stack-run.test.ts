// packages/cli/src/cli/stack-run.test.ts — run-issue --stack builds every pending slice in one run (#3798)
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunOutcome } from '@on-par/factory-core';
import { withSliceState, type SlicePlan } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { orderIssueChain, runIssueStack, runSliceStack } from './stack-run.js';

const story = (n: number) => ({
  schemaVersion: 1 as const,
  kind: 'story' as const,
  filesLikelyTouched: [],
  labels: [],
  title: `Story ${n}`,
  role: 'operator',
  want: `thing ${n} works`,
  soThat: 'value',
  problemStatement: `Problem ${n}`,
  inScope: [`Scope ${n}`],
  outOfScope: ['Persistent storage'],
  acceptanceCriteria: [{ name: `ac ${n}`, given: [], when: ['run'], then: ['works'] }],
  verification: [{ command: 'npm test', passWhen: 'passes' }],
  tracesTo: ['INT-PROBLEM-01'],
});
const freshPlan = (): SlicePlan => ({
  issue: 7,
  slices: [1, 2, 3].map((n) => ({ index: n, title: `S${n}`, story: story(n) as never, state: 'pending' as const })),
});
const branch = (k: number) => `factory/7-slice-${k}`;

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => {
  logSpy.mockClear();
  errSpy.mockClear();
});
const logged = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

/** A ship fake that reports slice k's ready outcome on call k (after `offset` sizing calls). */
function fakeShip(failOn?: number) {
  let call = 0;
  const bases: Array<string | undefined> = [];
  const ship = vi.fn(async (base: string | undefined, onOutcome: (o: RunOutcome) => void) => {
    call++;
    bases.push(base);
    if (call === failOn) throw new Error(`slice ${call} failed hard`);
    onOutcome({ state: 'ready', branch: branch(call), prNumber: 100 + call } as RunOutcome);
  });
  return { ship, bases };
}

const graphDeps = { repo: 'a/b', list: async () => [], shipMember: async () => {} };

describe('runIssueStack (#3798)', () => {
  it("builds every pending slice in one run, each on the previous slice's PR head", async () => {
    const { ship, bases } = fakeShip();
    await runIssueStack(7, undefined, { ...graphDeps, readSlicePlan: async () => freshPlan(), ship });

    expect(bases).toEqual([undefined, branch(1), branch(2)]);
    expect(logged()).toContain('slice 3/3 → PR #103 (base factory/7-slice-2)');
    expect(logged()).toContain('3/3 slices succeeded');
  });

  it('sizes an unsliced issue then builds all three slices in the same call', async () => {
    const reads = [undefined, freshPlan()];
    const bases: Array<string | undefined> = [];
    let call = 0;
    const ship = vi.fn(async (base: string | undefined, onOutcome: (o: RunOutcome) => void) => {
      call++;
      bases.push(base);
      if (call === 1) throw new Error('issue #7 sliced into 3');
      onOutcome({ state: 'ready', branch: branch(call - 1), prNumber: 100 + call - 1 } as RunOutcome);
    });
    await runIssueStack(7, undefined, { ...graphDeps, readSlicePlan: async () => reads.shift(), ship });

    expect(ship).toHaveBeenCalledTimes(4);
    expect(bases).toEqual([undefined, undefined, branch(1), branch(2)]);
  });

  it('skips slice 3 with stack stopped after slice 2 fails and exits 1', async () => {
    const { ship } = fakeShip(2);
    const err = await runIssueStack(7, undefined, { ...graphDeps, readSlicePlan: async () => freshPlan(), ship }).catch(
      (e: unknown) => e,
    );

    expect(ship).toHaveBeenCalledTimes(2);
    expect(logged()).toContain('slice 3/3 skipped: stack stopped: slice 2/3 failed');
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(1);
  });

  it('passes --base-branch to slice 1 only as its base', async () => {
    const { ship, bases } = fakeShip();
    await runIssueStack(7, 'feat/x', { ...graphDeps, readSlicePlan: async () => freshPlan(), ship });

    expect(bases).toEqual(['feat/x', branch(1), branch(2)]);
  });

  it("resumes at the first pending slice on the parent slice's branch", async () => {
    const plan = withSliceState(freshPlan(), 1, 'pr-open', 101, branch(1));
    const { ship, bases } = fakeShip();
    await runIssueStack(7, 'feat/x', { ...graphDeps, readSlicePlan: async () => plan, ship });

    expect(bases).toEqual([branch(1), branch(1)]);
    expect(logged()).toContain('building 2 in order');
  });

  it('resumes on --base-branch when the parent slice is merged', async () => {
    const plan = withSliceState(withSliceState(freshPlan(), 1, 'pr-open', 101, branch(1)), 1, 'merged', 101, branch(1));
    const { ship, bases } = fakeShip();
    await runIssueStack(7, 'feat/x', { ...graphDeps, readSlicePlan: async () => plan, ship });

    expect(bases[0]).toBe('feat/x');
  });

  it('returns after one run when the issue fits', async () => {
    const ship = vi.fn(async () => {});
    await runIssueStack(7, undefined, { ...graphDeps, readSlicePlan: async () => undefined, ship });

    expect(ship).toHaveBeenCalledTimes(1);
  });

  it('rethrows the sizing failure when no plan was recorded', async () => {
    const ship = vi.fn(async () => {
      throw new Error('parked over cap');
    });

    await expect(
      runIssueStack(7, undefined, { ...graphDeps, readSlicePlan: async () => undefined, ship }),
    ).rejects.toThrow('parked over cap');
  });

  it('reports every slice already built', async () => {
    let plan = freshPlan();
    for (const k of [1, 2, 3]) plan = withSliceState(plan, k, 'merged', 100 + k, branch(k));
    const ship = vi.fn(async () => {});
    await runIssueStack(7, undefined, { ...graphDeps, readSlicePlan: async () => plan, ship });

    expect(ship).not.toHaveBeenCalled();
    expect(logged()).toContain('every slice of #7 is already built');
  });
});

describe('runSliceStack (#3813)', () => {
  it('prints the run-brief subject in console text and the failure message', async () => {
    const { ship } = fakeShip(2);
    const err = await runSliceStack({ prefix: 'run-brief', label: 'big.md', failLabel: 'brief big.md' }, undefined, {
      readSlicePlan: async () => freshPlan(),
      ship,
    }).catch((e: unknown) => e);

    expect(logged()).toContain('run-brief: --stack — big.md has 3 slices; building 3 in order');
    expect(logged()).toContain('run-brief: [1/3] slice 1/3');
    expect((err as CliExitError).message).toBe('Run failed for one or more slices of brief big.md (listed above)');
  });
});

describe('issue dependency graph', () => {
  const item = (number: number, state: 'open' | 'closed' = 'open', repository = 'A/B') => ({
    number,
    state,
    repository,
    stateReason: null,
  });
  it('orders shared prerequisites, skips closed and cross-repository issues', async () => {
    const graph = new Map([
      [4, [item(2), item(3), item(8, 'closed'), item(9, 'open', 'x/y')]],
      [2, [item(1)]],
      [3, [item(1)]],
    ]);
    expect(await orderIssueChain(4, 'a/b', async (n) => graph.get(n) ?? [])).toEqual([1, 2, 3, 4]);
  });
  it('rejects self and longer cycles and propagates listing failures', async () => {
    await expect(orderIssueChain(1, 'a/b', async () => [item(1)])).rejects.toThrow('#1 → #1');
    await expect(orderIssueChain(1, 'a/b', async (n) => [item(n === 1 ? 2 : 1)])).rejects.toThrow('#1 → #2 → #1');
    await expect(
      orderIssueChain(1, 'a/b', async () => {
        throw new Error('listing failed');
      }),
    ).rejects.toThrow('listing failed');
  });
  it('builds issue prerequisites on successive PR heads', async () => {
    const calls: Array<[number, string | undefined]> = [];
    await runIssueStack(3, 'main', {
      ...graphDeps,
      list: async (n) => (n > 1 ? [item(n - 1)] : []),
      readSlicePlan: async () => undefined,
      ship: async () => {},
      shipMember: async (n, base, onOutcome) => {
        calls.push([n, base]);
        onOutcome({ state: 'ready', branch: `branch-${n}`, prNumber: n } as RunOutcome);
      },
    });
    expect(calls).toEqual([
      [1, 'main'],
      [2, 'branch-1'],
      [3, 'branch-2'],
    ]);
  });
  it('rejects an issue cycle before building', async () => {
    const shipMember = vi.fn();
    await expect(
      runIssueStack(1, undefined, {
        ...graphDeps,
        list: async () => [item(1)],
        shipMember,
        readSlicePlan: async () => undefined,
        ship: async () => {},
      }),
    ).rejects.toMatchObject({ code: 2 });
    expect(shipMember).not.toHaveBeenCalled();
  });
});
