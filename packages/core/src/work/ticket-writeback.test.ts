import { describe, expect, it, vi } from 'vitest';

import type { SlicePlanStore } from '../readiness/slice-plan-store.js';
import type { SlicePlan } from '../readiness/slice-plan.js';
import {
  closesTrailer,
  createLinearTicketWriteback,
  mirrorSlicePlanToTicket,
  postTicketComment,
  ticketKeyOf,
  ticketTrackerOf,
  type LinearTicketClient,
  type TicketWriteback,
} from './ticket-writeback.js';
import { isTicketKey, toWorkKey } from './work-key.js';

const ON12 = toWorkKey('ON-12');

function client(issue: { id: string; labels: Array<{ name: string }> } | null) {
  const addComment = vi.fn(async (_id: string, _body: string) => {});
  const findIssue = vi.fn(async (_key: string) => issue);
  return { addComment, findIssue, client: Object.assign({} as LinearTicketClient, { addComment, findIssue }) };
}

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

describe('createLinearTicketWriteback', () => {
  it('comment looks up the issue id and strips HTML comment markers', async () => {
    const c = client({ id: 'uuid-1', labels: [] });
    await createLinearTicketWriteback(c.client).comment(ON12, '<!-- marker v1 -->\nbody <!-- x -->text\n');
    expect(c.findIssue).toHaveBeenCalledWith('ON-12');
    expect(c.addComment).toHaveBeenCalledWith('uuid-1', 'body text');
  });

  it('comment leaves no comment opener behind from nested or unterminated markers', async () => {
    const c = client({ id: 'uuid-1', labels: [] });
    await createLinearTicketWriteback(c.client).comment(ON12, 'keep <!<!-- a -->-- b --> me <!-- unterminated');
    const [, posted] = c.addComment.mock.calls[0] ?? [];
    expect(posted).not.toContain('<!--');
    expect(posted).toBe('keep  me');
  });

  it('labels returns the label names', async () => {
    const c = client({ id: 'u', labels: [{ name: 'no-auto-merge' }, { name: 'lane' }] });
    await expect(createLinearTicketWriteback(c.client).labels(ON12)).resolves.toEqual(['no-auto-merge', 'lane']);
  });

  it('throws when the issue is not found', async () => {
    const wb = createLinearTicketWriteback(client(null).client);
    await expect(wb.comment(ON12, 'x')).rejects.toThrow('Linear issue ON-12 not found');
    await expect(wb.labels(ON12)).rejects.toThrow('Linear issue ON-12 not found');
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
