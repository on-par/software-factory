import { describe, expect, it } from 'vitest';
import type { BlockedByItem } from '../blockers/dependencies.js';
import { collectBatchPrerequisites, orderByPrerequisites } from './prerequisite-order.js';

const item = (number: number, state: 'open' | 'closed' = 'open', repository = 'o/r'): BlockedByItem => ({
  number,
  state,
  stateReason: null,
  repository,
});

describe('orderByPrerequisites', () => {
  it('orders the 10/19 chain #3175 → #3181 → #3176 prerequisite-first', () => {
    const prereqs = new Map([
      [3176, [3181]],
      [3181, [3175]],
    ]);
    expect(orderByPrerequisites([3176, 3181, 3175], prereqs)).toEqual({ ok: true, order: [3175, 3181, 3176] });
  });

  it('reports a two-issue cycle as [10, 11, 10]', () => {
    const prereqs = new Map([
      [10, [11]],
      [11, [10]],
    ]);
    expect(orderByPrerequisites([10, 11], prereqs)).toEqual({ ok: false, cycle: [10, 11, 10] });
  });

  it('ignores prerequisites outside the batch and keeps the given order', () => {
    expect(orderByPrerequisites([21, 5], new Map([[21, [20]]]))).toEqual({ ok: true, order: [21, 5] });
  });

  it('keeps the given order for independent issues', () => {
    expect(orderByPrerequisites([3, 1, 2], new Map())).toEqual({ ok: true, order: [3, 1, 2] });
  });

  it('collapses duplicate issues to their first position', () => {
    expect(orderByPrerequisites([2, 1, 2], new Map([[2, [1]]]))).toEqual({ ok: true, order: [1, 2] });
  });

  it('reports a self-prerequisite as a cycle', () => {
    expect(orderByPrerequisites([4], new Map([[4, [4]]]))).toEqual({ ok: false, cycle: [4, 4] });
  });

  it('reports a cycle that sits behind an orderable issue', () => {
    const prereqs = new Map([
      [2, [3]],
      [3, [2]],
    ]);
    expect(orderByPrerequisites([1, 2, 3], prereqs)).toEqual({ ok: false, cycle: [2, 3, 2] });
  });

  it('reports a cycle reached through a dependent of an already-visited node', () => {
    const prereqs = new Map([
      [1, [2, 3]],
      [2, [3]],
      [3, [2]],
    ]);
    expect(orderByPrerequisites([1, 2, 3], prereqs)).toEqual({ ok: false, cycle: [2, 3, 2] });
  });

  it('returns an empty order for an empty batch', () => {
    expect(orderByPrerequisites([], new Map())).toEqual({ ok: true, order: [] });
  });
});

describe('collectBatchPrerequisites', () => {
  const readers = (body: string, blocked: BlockedByItem[]) => ({
    repo: 'o/r',
    readIssueBody: async () => body,
    listBlockedBy: async () => blocked,
  });

  it('collects declared and blocked_by prerequisites as [7, 8]', async () => {
    const result = await collectBatchPrerequisites([1], readers('Prerequisite: #7', [item(8)]));
    expect(result).toEqual({ ok: true, prereqsOf: new Map([[1, [7, 8]]]) });
  });

  it('ignores closed and other-repo blocked_by items and dedupes overlap with declared', async () => {
    const result = await collectBatchPrerequisites(
      [1, 1],
      readers('Prerequisite: #7', [item(7), item(9, 'closed'), item(10, 'open', 'x/y'), item(11, 'open', 'O/R')]),
    );
    expect(result).toEqual({ ok: true, prereqsOf: new Map([[1, [7, 11]]]) });
  });

  it('returns an error naming the issue whose blocked_by lookup failed', async () => {
    const result = await collectBatchPrerequisites([1, 2], {
      ...readers('', []),
      listBlockedBy: async (n) => {
        if (n === 2) {
          throw new Error('boom');
        }
        return [];
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toBe(2);
      expect(result.error).toContain('#2');
      expect(result).not.toHaveProperty('prereqsOf');
    }
  });

  it('returns an error naming the issue whose body read failed', async () => {
    const result = await collectBatchPrerequisites([3], {
      ...readers('', []),
      readIssueBody: async () => {
        throw 'nope';
      },
    });
    expect(result).toEqual({ ok: false, issue: 3, error: '#3: could not read issue body: nope' });
  });
});
