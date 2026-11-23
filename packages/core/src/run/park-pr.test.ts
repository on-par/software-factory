import type { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';

import { recordArgs } from '../test-support/recorders.js';
import type { ParkReason } from './outcome.js';
import { parkedPrAction, renderParkedPrComment, settleParkedPullRequest } from './park-pr.js';
import { toWorkKey, workKeyFromIssue } from '../work/work-key.js';

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
  'check-infra',
  'time-budget',
  'not-ready',
];

function fake(opts: { open?: boolean; draft?: boolean; updateError?: Error } = {}) {
  const requests: [string, unknown][] = [];
  const octokit = Object.assign({} as Octokit, {
    graphql: async (args: unknown) => (requests.push(['graphql', args]), {}),
    rest: {
      pulls: {
        list: async () => ({ data: opts.open === false ? [] : [{ number: 77 }] }),
        get: async () => ({ data: { draft: opts.draft ?? true, node_id: 'PR_1' } }),
        update: async (args: { state: string }) => {
          requests.push(['update', args]);
          if (opts.updateError) throw opts.updateError;
          return { data: {} };
        },
      },
      issues: {
        createComment: async (args: unknown) => (requests.push(['comment', args]), { data: {} }),
      },
      git: { deleteRef: async (args: unknown) => void requests.push(['deleteRef', args]) },
    },
  });
  return { octokit, requests };
}

const base = { repo: 'o/r', issue: workKeyFromIssue(9), branch: 'issue-9-x' };

describe('renderParkedPrComment', () => {
  it('renders a non-numeric work key as-is', () => {
    expect(renderParkedPrComment({ issue: toWorkKey('PROJ-12'), reason: 'fail', branch: 'b' })).toContain('#PROJ-12');
  });
});

describe('parkedPrAction', () => {
  it.each(ALL)('decides for %s', (reason) => {
    const closeAlways = ['ci-infra', 'conflict'].includes(reason);
    const closeIfRed = ['fail', 'timeout'].includes(reason);
    expect(parkedPrAction(reason, false)).toBe(closeAlways || closeIfRed ? 'close' : 'leave');
    expect(parkedPrAction(reason, true)).toBe(closeAlways ? 'close' : reason === 'ci-failed' ? 'leave' : 'ready');
  });

  it('leaves a ci-failed PR open whether or not it is green (#3998)', () => {
    expect(parkedPrAction('ci-failed', false)).toBe('leave');
    expect(parkedPrAction('ci-failed', true)).toBe('leave');
  });
});

describe('settleParkedPullRequest', () => {
  it.each(['ci-infra', 'fail', 'conflict', 'timeout'] as const)(
    'closes the PR with one comment naming %s and linking the issue, and keeps the branch',
    async (reason) => {
      const { octokit, requests } = fake();
      const out = await settleParkedPullRequest({ octokit, ...base, reason, prNumber: 77, log: () => {} });
      expect(out).toEqual({ action: 'closed', prNumber: 77 });
      const comments = requests.filter((r) => r[0] === 'comment');
      expect(comments).toHaveLength(1);
      expect(comments[0][1]).toMatchObject({ issue_number: 77, body: expect.stringContaining(reason) });
      expect(comments[0][1]).toMatchObject({ body: expect.stringContaining('#9') });
      expect(requests).toContainEqual(['update', expect.objectContaining({ pull_number: 77, state: 'closed' })]);
      expect(requests.some((r) => r[0] === 'deleteRef')).toBe(false);
    },
  );

  it('marks a green and checked PR ready instead of closing it', async () => {
    const { octokit, requests } = fake();
    const out = await settleParkedPullRequest({
      octokit,
      ...base,
      reason: 'fail',
      greenAndChecked: true,
      log: () => {},
    });
    expect(out).toEqual({ action: 'readied', prNumber: 77 });
    expect(requests.map((r) => r[0])).toEqual(['graphql']);
  });

  it('leaves a ci-failed PR open without commenting or closing (#3998)', async () => {
    const { octokit, requests } = fake();
    const out = await settleParkedPullRequest({ octokit, ...base, reason: 'ci-failed', prNumber: 77, log: () => {} });
    expect(out).toEqual({ action: 'left', prNumber: 77 });
    expect(requests).toEqual([]);
  });

  it('leaves the PR alone on an escalate park that is not green', async () => {
    const { octokit, requests } = fake();
    const out = await settleParkedPullRequest({ octokit, ...base, reason: 'escalate', prNumber: 77, log: () => {} });
    expect(out).toEqual({ action: 'left', prNumber: 77 });
    expect(requests).toEqual([]);
  });

  it('is a no-op when the branch has no open PR', async () => {
    const { octokit, requests } = fake({ open: false });
    expect(await settleParkedPullRequest({ octokit, ...base, reason: 'fail', log: () => {} })).toEqual({
      action: 'none',
    });
    expect(requests).toEqual([]);
  });

  it('never throws: a pulls.update rejection returns failed and logs a warn naming the PR', async () => {
    const { octokit } = fake({ updateError: new Error('boom') });
    const log = recordArgs((_t: string, _m: string) => {});
    const out = await settleParkedPullRequest({ octokit, ...base, reason: 'fail', prNumber: 77, log: log.fn });
    expect(out.action).toBe('failed');
    expect(log.calls).toContainEqual(['warn', expect.stringContaining('#77')]);
  });
});
