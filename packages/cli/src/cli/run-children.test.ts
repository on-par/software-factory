import { describe, expect, it, vi } from 'vitest';
import { formatChildRunSummary, runChildrenInOrder, type ChildRunResult } from './run-children.js';

describe('runChildrenInOrder', () => {
  it('runs children one at a time in the given order', async () => {
    const events: string[] = [];
    const results = await runChildrenInOrder([10, 11], async (issue) => {
      events.push(`start ${issue}`);
      if (issue === 10) await new Promise((r) => setTimeout(r, 20));
      events.push(`end ${issue}`);
      return { issue, status: 'ready', prNumber: issue + 100 };
    });
    expect(events).toEqual(['start 10', 'end 10', 'start 11', 'end 11']);
    expect(results.map((r) => r.status)).toEqual(['ready', 'ready']);
  });

  it('stops at the first failure and marks the rest not-run', async () => {
    const runChild = vi.fn(async (issue: number): Promise<ChildRunResult> =>
      issue === 11 ? { issue, status: 'failed', detail: 'boom' } : { issue, status: 'ready', prNumber: 1 },
    );
    const results = await runChildrenInOrder([10, 11, 12, 13], runChild);
    expect(runChild.mock.calls.map((c) => c[0])).toEqual([10, 11]);
    expect(results.map((r) => r.status)).toEqual(['ready', 'failed', 'not-run', 'not-run']);
  });

  it('records a thrown runChild as failed with the message', async () => {
    const results = await runChildrenInOrder([10, 11], async () => {
      throw new Error('kaput');
    });
    expect(results).toEqual([
      { issue: 10, status: 'failed', detail: 'kaput' },
      { issue: 11, status: 'not-run' },
    ]);
  });

  it('stringifies a non-Error throw', async () => {
    const results = await runChildrenInOrder([10], async () => {
      throw 'plain';
    });
    expect(results[0]).toEqual({ issue: 10, status: 'failed', detail: 'plain' });
  });
});

describe('formatChildRunSummary', () => {
  it('renders every line kind and the footer', () => {
    expect(
      formatChildRunSummary(5, [
        { issue: 10, status: 'ready', prNumber: 101 },
        { issue: 11, status: 'ready' },
        { issue: 12, status: 'failed', detail: 'bad' },
        { issue: 13, status: 'failed' },
        { issue: 14, status: 'not-run' },
      ]),
    ).toEqual([
      'Children of #5:',
      '  #10 → PR #101 ready for review',
      '  #11 → ready (no PR number)',
      '  #12 → failed: bad',
      '  #13 → failed',
      '  #14 → not run',
      '2/5 children ready for review',
    ]);
  });
});
