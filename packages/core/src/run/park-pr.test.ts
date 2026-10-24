import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import type { ParkReason } from './outcome.js';
import { parkedPrAction, settleParkedPullRequest } from './park-pr.js';

const ALL: ParkReason[] = [
  'escalate',
  'timeout',
  'fail',
  'conflict',
  'ci-failed',
  'ci-infra',
  'held',
  'config',
  'blocked',
  'all_providers_down',
  'sandbox-env',
];

function fake(opts: { open?: boolean; draft?: boolean; updateError?: Error } = {}) {
  const createComment = vi.fn(async (_args: { issue_number: number; body: string }) => ({ data: {} }));
  const update = vi.fn(async (_args: { state: string }) => {
    if (opts.updateError) throw opts.updateError;
    return { data: {} };
  });
  const deleteRef = vi.fn();
  const graphql = vi.fn(async () => ({}));
  const octokit = Object.assign({} as Octokit, {
    graphql,
    rest: {
      pulls: {
        list: vi.fn(async () => ({ data: opts.open === false ? [] : [{ number: 77 }] })),
        get: vi.fn(async () => ({ data: { draft: opts.draft ?? true, node_id: 'PR_1' } })),
        update,
      },
      issues: { createComment },
      git: { deleteRef },
    },
  });
  return { octokit, createComment, update, deleteRef, graphql };
}

const base = { repo: 'o/r', issue: 9, branch: 'issue-9-x' };

describe('parkedPrAction', () => {
  it.each(ALL)('decides for %s', (reason) => {
    const closeAlways = ['ci-failed', 'ci-infra', 'conflict'].includes(reason);
    const closeIfRed = ['fail', 'timeout'].includes(reason);
    expect(parkedPrAction(reason, false)).toBe(closeAlways || closeIfRed ? 'close' : 'leave');
    expect(parkedPrAction(reason, true)).toBe(closeAlways ? 'close' : 'ready');
  });
});

describe('settleParkedPullRequest', () => {
  it.each(['ci-failed', 'ci-infra', 'fail', 'conflict', 'timeout'] as const)(
    'closes the PR with one comment naming %s and linking the issue, and keeps the branch',
    async (reason) => {
      const { octokit, createComment, update, deleteRef } = fake();
      const log = vi.fn();
      const out = await settleParkedPullRequest({ octokit, ...base, reason, prNumber: 77, log });
      expect(out).toEqual({ action: 'closed', prNumber: 77 });
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(createComment.mock.calls[0][0].issue_number).toBe(77);
      expect(createComment.mock.calls[0][0].body).toContain(reason);
      expect(createComment.mock.calls[0][0].body).toContain('#9');
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 77, state: 'closed' }));
      expect(deleteRef).not.toHaveBeenCalled();
    },
  );

  it('marks a green and checked PR ready instead of closing it', async () => {
    const { octokit, update, graphql } = fake();
    const out = await settleParkedPullRequest({
      octokit,
      ...base,
      reason: 'fail',
      greenAndChecked: true,
      log: vi.fn(),
    });
    expect(out).toEqual({ action: 'readied', prNumber: 77 });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('still closes a green ci-failed park', async () => {
    const { octokit, update } = fake();
    await settleParkedPullRequest({ octokit, ...base, reason: 'ci-failed', greenAndChecked: true, log: vi.fn() });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('leaves the PR alone on an escalate park that is not green', async () => {
    const { octokit, createComment, update, graphql } = fake();
    const out = await settleParkedPullRequest({ octokit, ...base, reason: 'escalate', prNumber: 77, log: vi.fn() });
    expect(out).toEqual({ action: 'left', prNumber: 77 });
    expect(createComment).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it('is a no-op when the branch has no open PR', async () => {
    const { octokit, update } = fake({ open: false });
    expect(await settleParkedPullRequest({ octokit, ...base, reason: 'fail', log: vi.fn() })).toEqual({
      action: 'none',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('never throws: a pulls.update rejection returns failed and logs a warn naming the PR', async () => {
    const { octokit } = fake({ updateError: new Error('boom') });
    const log = vi.fn();
    const out = await settleParkedPullRequest({ octokit, ...base, reason: 'fail', prNumber: 77, log });
    expect(out.action).toBe('failed');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('#77'));
  });
});
