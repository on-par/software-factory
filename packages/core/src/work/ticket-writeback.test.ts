import { describe, expect, it, vi } from 'vitest';

import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import {
  closesTrailer,
  mirrorSlicePlanToTicket,
  postTicketComment,
  ticketKeyOf,
  ticketTrackerOf,
  type TicketWriteback,
} from './ticket-writeback.js';
import { isTicketKey, toWorkKey } from './work-key.js';

const ON12 = toWorkKey('ON-12');

describe('closesTrailer', () => {
  it.each([
    ['github', true, 'Closes #12'],
    ['github', false, 'Part of #12'],
    ['linear', true, 'Fixes 12'],
    ['linear', false, 'Part of 12'],
  ] as const)('%s final=%s -> %s', (tracker, final, expected) => {
    expect(closesTrailer(tracker, toWorkKey('12'), final)).toBe(expected);
  });
});

describe('ticketTrackerOf / ticketKeyOf', () => {
  it.each([
    [undefined, 'github', undefined],
    [{ kind: 'github-issue' }, 'github', undefined],
    [{ kind: 'local-brief' }, undefined, undefined],
    [{ kind: 'linear-issue', key: ON12 }, 'linear', ON12],
    [{ kind: 'linear-issue' }, 'linear', undefined],
    [{ kind: 'jira-issue', key: ON12 }, undefined, undefined],
  ] as const)('%j', (work, tracker, key) => {
    expect(ticketTrackerOf(work)).toBe(tracker);
    expect(ticketKeyOf(work)).toBe(key);
  });
});

describe('isTicketKey', () => {
  it('keeps numbers and upper-case keys and drops pseudo ids', () => {
    for (const ok of ['123', 'ON-12', 'AB2-7']) expect(isTicketKey(ok)).toBe(true);
    for (const bad of ['-', 'all', 'issue-12', 'lane-x', 'on-12', 'ON-0', 'ON-']) expect(isTicketKey(bad)).toBe(false);
  });
});

describe('postTicketComment', () => {
  it('posts and resolves true', async () => {
    const comment = vi.fn(async () => {});
    const wb: TicketWriteback = { comment, labels: async () => [] };
    await expect(postTicketComment(wb, ON12, 'hi', vi.fn())).resolves.toBe(true);
    expect(comment).toHaveBeenCalledWith(ON12, 'hi');
  });

  it('warns and resolves false when the Linear comment fails', async () => {
    const warn = vi.fn();
    const wb: TicketWriteback = {
      comment: async () => {
        throw new Error('boom');
      },
      labels: async () => [],
    };
    await expect(postTicketComment(wb, ON12, 'hi', warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('could not post to Linear issue ON-12: boom');
  });

  it('warns when no writeback is wired', async () => {
    const warn = vi.fn();
    await expect(postTicketComment(undefined, ON12, 'hi', warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('no Linear writeback is wired; could not post to ON-12');
  });
});

describe('mirrorSlicePlanToTicket', () => {
  const plan: SlicePlan = { issue: 12, slices: [] };

  function store() {
    const save = vi.fn(async (_plan: SlicePlan) => ({ where: 'comment 1' }));
    const find = vi.fn(async () => ({ status: 'not-found' as const }));
    return { save, find, store: { save, find } as SlicePlanStore };
  }

  it('mirrors a saved slice plan to the Linear issue', async () => {
    const s = store();
    const comment = vi.fn(async () => {});
    const mirrored = mirrorSlicePlanToTicket(s.store, { comment, labels: async () => [] }, ON12, vi.fn());
    await expect(mirrored.save(plan)).resolves.toEqual({ where: 'comment 1' });
    expect(s.save).toHaveBeenCalledWith(plan);
    expect(comment).toHaveBeenCalledTimes(1);
    await mirrored.find();
    expect(s.find).toHaveBeenCalled();
  });

  it('still returns the inner save result when the mirror fails', async () => {
    const s = store();
    const warn = vi.fn();
    const failing: TicketWriteback = {
      comment: async () => {
        throw new Error('down');
      },
      labels: async () => [],
    };
    await expect(mirrorSlicePlanToTicket(s.store, failing, ON12, warn).save(plan)).resolves.toEqual({
      where: 'comment 1',
    });
    expect(warn).toHaveBeenCalled();
  });
});
