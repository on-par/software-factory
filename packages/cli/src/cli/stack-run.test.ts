// packages/cli/src/cli/stack-run.test.ts — run-issue --stack builds every pending slice in one run (#3798)
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunOutcome } from '@on-par/factory-core';
import { withSliceState, type SlicePlan } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { runIssueStack } from './stack-run.js';

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

describe('runIssueStack (#3798)', () => {
  it("builds every pending slice in one run, each on the previous slice's PR head", async () => {
    const { ship, bases } = fakeShip();
    await runIssueStack(7, undefined, { readSlicePlan: async () => freshPlan(), ship });

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
    await runIssueStack(7, undefined, { readSlicePlan: async () => reads.shift(), ship });

    expect(ship).toHaveBeenCalledTimes(4);
    expect(bases).toEqual([undefined, undefined, branch(1), branch(2)]);
  });

  it('skips slice 3 with stack stopped after slice 2 fails and exits 1', async () => {
    const { ship } = fakeShip(2);
    const err = await runIssueStack(7, undefined, { readSlicePlan: async () => freshPlan(), ship }).catch(
      (e: unknown) => e,
    );

    expect(ship).toHaveBeenCalledTimes(2);
    expect(logged()).toContain('slice 3/3 skipped: stack stopped: slice 2/3 failed');
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).code).toBe(1);
  });

  it('passes --base-branch to slice 1 only as its base', async () => {
    const { ship, bases } = fakeShip();
    await runIssueStack(7, 'feat/x', { readSlicePlan: async () => freshPlan(), ship });

    expect(bases).toEqual(['feat/x', branch(1), branch(2)]);
  });

  it("resumes at the first pending slice on the parent slice's branch", async () => {
    const plan = withSliceState(freshPlan(), 1, 'pr-open', 101, branch(1));
    const { ship, bases } = fakeShip();
    await runIssueStack(7, 'feat/x', { readSlicePlan: async () => plan, ship });

    expect(bases).toEqual([branch(1), branch(1)]);
    expect(logged()).toContain('building 2 in order');
  });

  it('resumes on --base-branch when the parent slice is merged', async () => {
    const plan = withSliceState(withSliceState(freshPlan(), 1, 'pr-open', 101, branch(1)), 1, 'merged', 101, branch(1));
    const { ship, bases } = fakeShip();
    await runIssueStack(7, 'feat/x', { readSlicePlan: async () => plan, ship });

    expect(bases[0]).toBe('feat/x');
  });

  it('returns after one run when the issue fits', async () => {
    const ship = vi.fn(async () => {});
    await runIssueStack(7, undefined, { readSlicePlan: async () => undefined, ship });

    expect(ship).toHaveBeenCalledTimes(1);
  });

  it('rethrows the sizing failure when no plan was recorded', async () => {
    const ship = vi.fn(async () => {
      throw new Error('parked over cap');
    });

    await expect(runIssueStack(7, undefined, { readSlicePlan: async () => undefined, ship })).rejects.toThrow(
      'parked over cap',
    );
  });

  it('reports every slice already built', async () => {
    let plan = freshPlan();
    for (const k of [1, 2, 3]) plan = withSliceState(plan, k, 'merged', 100 + k, branch(k));
    const ship = vi.fn(async () => {});
    await runIssueStack(7, undefined, { readSlicePlan: async () => plan, ship });

    expect(ship).not.toHaveBeenCalled();
    expect(logged()).toContain('every slice of #7 is already built');
  });
});
