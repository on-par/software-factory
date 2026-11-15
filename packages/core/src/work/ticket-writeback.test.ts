import { describe, expect, it } from 'vitest';

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
import { isTicketKey, toWorkKey, type WorkKey } from './work-key.js';

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
    const posted: Array<[WorkKey, string]> = [];
    const comment = async (key: WorkKey, body: string) => {
      posted.push([key, body]);
    };
    const wb: TicketWriteback = { comment, labels: async () => [] };
    await expect(postTicketComment(wb, ON12, 'hi', () => {})).resolves.toBe(true);
    expect(posted).toEqual([[ON12, 'hi']]);
  });

  it('warns and resolves false when the Linear comment fails', async () => {
    const warnings: string[] = [];
    const warn = (m: string) => {
      warnings.push(m);
    };
    const wb: TicketWriteback = {
      comment: async () => {
        throw new Error('boom');
      },
      labels: async () => [],
    };
    await expect(postTicketComment(wb, ON12, 'hi', warn)).resolves.toBe(false);
    expect(warnings).toEqual(['could not post to Linear issue ON-12: boom']);
  });

  it('warns when no writeback is wired', async () => {
    const warnings: string[] = [];
    const warn = (m: string) => {
      warnings.push(m);
    };
    await expect(postTicketComment(undefined, ON12, 'hi', warn)).resolves.toBe(false);
    expect(warnings).toEqual(['no Linear writeback is wired; could not post to ON-12']);
  });
});

describe('mirrorSlicePlanToTicket', () => {
  const plan: SlicePlan = { issue: 12, slices: [] };

  function store() {
    const saved: SlicePlan[] = [];
    const save = async (p: SlicePlan) => {
      saved.push(p);
      return { where: 'comment 1' };
    };
    const find = async () => ({ status: 'not-found' as const });
    return { saved, store: { save, find } as SlicePlanStore };
  }

  it('mirrors a saved slice plan to the Linear issue', async () => {
    const s = store();
    const posted: Array<[WorkKey, string]> = [];
    const comment = async (key: WorkKey, body: string) => {
      posted.push([key, body]);
    };
    const mirrored = mirrorSlicePlanToTicket(s.store, { comment, labels: async () => [] }, ON12, () => {});
    await expect(mirrored.save(plan)).resolves.toEqual({ where: 'comment 1' });
    expect(s.saved).toEqual([plan]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.[0]).toBe(ON12);
    expect(posted[0]?.[1]).not.toBe('');
    await expect(mirrored.find()).resolves.toEqual({ status: 'not-found' });
  });

  it('still returns the inner save result when the mirror fails', async () => {
    const s = store();
    const warnings: string[] = [];
    const warn = (m: string) => {
      warnings.push(m);
    };
    const failing: TicketWriteback = {
      comment: async () => {
        throw new Error('down');
      },
      labels: async () => [],
    };
    await expect(mirrorSlicePlanToTicket(s.store, failing, ON12, warn).save(plan)).resolves.toEqual({
      where: 'comment 1',
    });
    expect(warnings).toEqual(['could not post to Linear issue ON-12: down']);
  });
});
