import { describe, expect, it, vi } from 'vitest';
import { childRunSucceeded, formatChildRunSummary, runChildrenInOrder, type ChildRunResult } from './run-children.js';

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

  it('continues past a failed child', async () => {
    const runChild = vi.fn(async (issue: number): Promise<ChildRunResult> =>
      issue === 11 ? { issue, status: 'failed', detail: 'boom' } : { issue, status: 'ready', prNumber: 1 },
    );
    const results = await runChildrenInOrder([10, 11, 12, 13], runChild);
    expect(runChild.mock.calls.map((c) => c[0])).toEqual([10, 11, 12, 13]);
    expect(results.map((r) => r.status)).toEqual(['ready', 'failed', 'ready', 'ready']);
  });

  it('records a thrown runChild as failed with the message', async () => {
    const results = await runChildrenInOrder([10, 11], async () => {
      throw new Error('kaput');
    });
    expect(results).toEqual([
      { issue: 10, status: 'failed', detail: 'kaput' },
      { issue: 11, status: 'failed', detail: 'kaput' },
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
        { issue: 15, status: 'not-run', detail: '.factory/STOP present' },
      ]),
    ).toEqual([
      'Children of #5:',
      '  #10 → PR #101 ready for review',
      '  #11 → ready (no PR number)',
      '  #12 → failed: bad',
      '  #13 → failed',
      '  #14 → not run',
      '  #15 → not run: .factory/STOP present',
      '2/6 children ready for review',
    ]);
  });
});

describe('shouldStop (#1749)', () => {
  const ok = async (issue: number): Promise<ChildRunResult> => ({ issue, status: 'ready', prNumber: issue });

  it('marks the rest not-run once shouldStop is true and stops asking', async () => {
    const runChild = vi.fn(ok);
    const shouldStop = vi.fn((n: number) => n === 11);
    const results = await runChildrenInOrder([10, 11, 12], runChild, [], shouldStop);
    expect(runChild.mock.calls.map((c) => c[0])).toEqual([10]);
    expect(results.slice(1)).toEqual([
      { issue: 11, status: 'not-run', detail: '.factory/STOP present' },
      { issue: 12, status: 'not-run', detail: '.factory/STOP present' },
    ]);
    expect(shouldStop.mock.calls.map((c) => c[0])).toEqual([10, 11]);
  });

  it('runs nothing when stopped before the first child', async () => {
    const runChild = vi.fn(ok);
    const results = await runChildrenInOrder([10, 11], runChild, [], () => true);
    expect(runChild).not.toHaveBeenCalled();
    expect(results.every((r) => r.status === 'not-run')).toBe(true);
  });

  it('marks expansion children and later siblings not-run when stopped after a decomposed child', async () => {
    let stop = false;
    const results = await runChildrenInOrder(
      [10, 11],
      async (issue) => {
        stop = true;
        return { issue, status: 'decomposed', children: [20, 21] };
      },
      [],
      () => stop && true,
    );
    expect(results.map((r) => [r.issue, r.status])).toEqual([
      [10, 'decomposed'],
      [20, 'not-run'],
      [21, 'not-run'],
      [11, 'not-run'],
    ]);
  });
});

describe('nested decomposition and skipped children (#1748)', () => {
  const ready = (issue: number): ChildRunResult => ({ issue, status: 'ready', prNumber: issue });
  const splitter = (map: Record<number, number[]>) => {
    const calls: number[] = [];
    const runChild = async (issue: number): Promise<ChildRunResult> => {
      calls.push(issue);
      return map[issue] ? { issue, status: 'decomposed', children: map[issue] } : ready(issue);
    };
    return { calls, runChild };
  };

  it('runs a nested split in place, before later siblings', async () => {
    const { calls, runChild } = splitter({ 10: [20, 21] });
    const results = await runChildrenInOrder([10, 11], runChild);
    expect(calls).toEqual([10, 20, 21, 11]);
    expect(results.map((r) => r.status)).toEqual(['decomposed', 'ready', 'ready', 'ready']);
  });

  it('drops already-seen children from a nested split', async () => {
    const { calls, runChild } = splitter({ 10: [11, 5, 20] });
    await runChildrenInOrder([10, 11], runChild, [5]);
    expect(calls).toEqual([10, 20, 11]);
  });

  it('expands nested splits at any depth', async () => {
    const { calls, runChild } = splitter({ 10: [20], 20: [30] });
    await runChildrenInOrder([10, 11], runChild);
    expect(calls).toEqual([10, 20, 30, 11]);
  });

  it('treats a decomposed result without children as expanding to nothing', async () => {
    const results = await runChildrenInOrder([10, 11], async (issue) =>
      issue === 10 ? { issue, status: 'decomposed' } : ready(issue),
    );
    expect(results.map((r) => r.status)).toEqual(['decomposed', 'ready']);
  });

  it('continues after a skipped child', async () => {
    const results = await runChildrenInOrder([10, 11], async (issue) =>
      issue === 10 ? { issue, status: 'skipped', detail: 'closed' } : ready(issue),
    );
    expect(results.map((r) => r.status)).toEqual(['skipped', 'ready']);
  });

  it('keeps running siblings when a failure follows an expansion', async () => {
    const results = await runChildrenInOrder([10, 11], async (issue) => {
      if (issue === 10) return { issue, status: 'decomposed', children: [20, 21] };
      return issue === 20 ? { issue, status: 'failed', detail: 'x' } : ready(issue);
    });
    expect(results.map((r) => [r.issue, r.status])).toEqual([
      [10, 'decomposed'],
      [20, 'failed'],
      [21, 'ready'],
      [11, 'ready'],
    ]);
  });

  it('childRunSucceeded accepts ready, skipped and decomposed only', () => {
    expect(childRunSucceeded([ready(1), { issue: 2, status: 'skipped' }, { issue: 3, status: 'decomposed' }])).toBe(
      true,
    );
    expect(childRunSucceeded([ready(1), { issue: 2, status: 'failed' }])).toBe(false);
    expect(childRunSucceeded([ready(1), { issue: 2, status: 'not-run' }])).toBe(false);
  });

  it('summarises skipped and decomposed children', () => {
    const lines = formatChildRunSummary(5, [
      { issue: 10, status: 'skipped', detail: '#10 already closed' },
      { issue: 11, status: 'skipped' },
      { issue: 12, status: 'decomposed', children: [20, 21] },
      ready(20),
    ]);
    expect(lines).toContain('  #10 → skipped: #10 already closed');
    expect(lines).toContain('  #11 → skipped');
    expect(lines).toContain('  #12 → decomposed into #20, #21');
    expect(lines.at(-1)).toBe('1/3 children ready for review, 2 skipped');
  });
});
