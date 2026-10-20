import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { SlicePlan } from '../readiness/slice-plan.js';
import {
  renderStackOrderLine,
  replaceStackOrderLine,
  STACK_ORDER_MARKER,
  stackPositionFor,
  updateParentStackOrder,
} from './stack-order.js';

const plan = (prs: Array<number | undefined> = []): SlicePlan => ({
  issue: 7,
  slices: [1, 2, 3].map((n) => ({
    index: n,
    title: `S${n}`,
    story: {} as never,
    state: 'pending' as const,
    prNumber: prs[n - 1],
  })),
});

describe('stackPositionFor', () => {
  it('puts slice 1 on main with the next slice branch', () => {
    expect(stackPositionFor(plan(), 1, undefined)).toEqual({
      index: 1,
      count: 3,
      base: 'main',
      next: { branch: 'factory/7-slice-2' },
    });
  });

  it('puts slice k on the parent branch and strips origin/', () => {
    const p = stackPositionFor(plan([41]), 2, 'origin/factory/7-slice-1');
    expect(p).toMatchObject({ base: 'factory/7-slice-1', basePr: 41 });
  });

  it('has no next on the top slice and no basePr when unrecorded', () => {
    const p = stackPositionFor(plan(), 3, 'factory/7-slice-2');
    expect(p.next).toBeUndefined();
    expect(p.basePr).toBeUndefined();
  });
});

describe('renderStackOrderLine', () => {
  it('names the PR, base, and next branch', () => {
    const line = renderStackOrderLine({ index: 2, count: 3, base: 'b', basePr: 41, next: { branch: 'n' } });
    expect(line).toBe(`${STACK_ORDER_MARKER}\n**Stack:** slice 2/3 — stacked on #41 (\`b\`); next: slice 3 (\`n\`)`);
  });

  it('names the next PR and the top of stack', () => {
    expect(renderStackOrderLine({ index: 1, count: 2, base: 'main', next: { branch: 'n', prNumber: 9 } })).toContain(
      'next: slice 2 #9',
    );
    expect(renderStackOrderLine({ index: 2, count: 2, base: 'b' })).toContain('(top of stack)');
  });
});

describe('replaceStackOrderLine', () => {
  const line = `${STACK_ORDER_MARKER}\nNEW`;
  it('replaces an existing marker line pair', () => {
    expect(replaceStackOrderLine(`a\n${STACK_ORDER_MARKER}\nOLD\nb`, line)).toBe(`a\n${STACK_ORDER_MARKER}\nNEW\nb`);
  });

  it('inserts after the Summary paragraph when absent', () => {
    expect(replaceStackOrderLine('## Summary\nHi.\n\n## Proof\nx', line)).toBe(
      `## Summary\nHi.\n\n${STACK_ORDER_MARKER}\nNEW\n\n## Proof\nx`,
    );
  });

  it('appends when there is no Summary', () => {
    expect(replaceStackOrderLine('body', line)).toBe(`body\n\n${line}\n`);
  });
});

describe('updateParentStackOrder', () => {
  const make = (get = vi.fn(async () => ({ data: { body: '## Summary\nHi.' } }))) => {
    const update = vi.fn(async (_a: unknown) => ({}));
    const octokit: Octokit = { rest: { pulls: { get, update } } } as never;
    return { octokit, get, update };
  };

  it('is a no-op for slice 1 or an unrecorded parent PR', async () => {
    const { octokit, get } = make();
    const log = vi.fn();
    await updateParentStackOrder({ octokit, repo: 'o/r', plan: plan([41]), index: 1, prNumber: 50, log });
    await updateParentStackOrder({ octokit, repo: 'o/r', plan: plan(), index: 2, prNumber: 50, log });
    expect(get).not.toHaveBeenCalled();
  });

  it("rewrites the parent PR's body to name the new PR as next", async () => {
    const { octokit, update } = make();
    await updateParentStackOrder({ octokit, repo: 'o/r', plan: plan([41]), index: 2, prNumber: 50, log: vi.fn() });
    const arg = update.mock.calls[0]![0] as { pull_number: number; body: string };
    expect(arg.pull_number).toBe(41);
    expect(arg.body).toContain('slice 1/3');
    expect(arg.body).toContain('next: slice 2 #50');
  });

  it('logs and does not throw when pulls.get rejects', async () => {
    const { octokit } = make(vi.fn(async () => Promise.reject(new Error('nope'))));
    const log = vi.fn();
    await updateParentStackOrder({ octokit, repo: 'o/r', plan: plan([41]), index: 2, prNumber: 50, log });
    expect(log).toHaveBeenCalledWith(
      'ship',
      expect.stringContaining('could not update the stack order on slice 1 PR #41'),
    );
  });
});

describe('stackPositionFor on main after the lower slice merged (#3367)', () => {
  it('omits basePr when the base is main', () => {
    const position = stackPositionFor(plan([11]), 2, undefined);
    expect(position.base).toBe('main');
    expect(position).not.toHaveProperty('basePr');
  });
});
