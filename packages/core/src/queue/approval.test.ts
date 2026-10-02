import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { loadFactoryConfig } from '../config/index.js';
import type { EnqueueResult } from './github-queue.js';
import {
  approvalMarker,
  approveIssues,
  computeApprovalHash,
  createOctokitApprovalClient,
  createOctokitCollaboratorPermissionClient,
  formatApprovalComment,
  isTrustedApprover,
  type ApprovalGitHubClient,
  type CollaboratorPermissionClient,
} from './approval.js';

const base = { owner: 'o', repo: 'r' };
const fake = (impl: () => Promise<string>) => {
  const getPermissionLevel = vi.fn(impl);
  return { getPermissionLevel } satisfies CollaboratorPermissionClient;
};

describe('intake defaults', () => {
  it('defaults to warn with no approvers', () => {
    const cfg = loadFactoryConfig();
    expect(cfg.intake.enforce).toBe('warn');
    expect(cfg.intake.trustedApprovers).toBeUndefined();
    expect('trustedApprovers' in defaultFactoryConfig.intake).toBe(false);
  });
});

describe('isTrustedApprover', () => {
  it('trusts only listed logins, case-insensitively, without calling the client', async () => {
    const client = fake(async () => 'admin');
    const opts = { ...base, trustedApprovers: ['patrob'], client };
    expect(await isTrustedApprover('patrob', opts)).toBe(true);
    expect(await isTrustedApprover('PatRob', opts)).toBe(true);
    expect(await isTrustedApprover('someone-else', opts)).toBe(false);
    expect(client.getPermissionLevel).not.toHaveBeenCalled();
  });

  it('trusts nobody for an explicit empty list', async () => {
    const client = fake(async () => 'admin');
    expect(await isTrustedApprover('patrob', { ...base, trustedApprovers: [], client })).toBe(false);
    expect(client.getPermissionLevel).not.toHaveBeenCalled();
  });

  it('falls back to admin permission when the list is unset', async () => {
    const admin = fake(async () => 'admin');
    expect(await isTrustedApprover('u', { ...base, client: admin })).toBe(true);
    expect(admin.getPermissionLevel).toHaveBeenCalledWith({ owner: 'o', repo: 'r', username: 'u' });
    for (const level of ['write', 'read', 'none', 'maintain']) {
      expect(await isTrustedApprover('u', { ...base, client: fake(async () => level) })).toBe(false);
    }
  });

  it('fails closed on lookup errors', async () => {
    const throwing: CollaboratorPermissionClient = {
      getPermissionLevel: () => {
        throw new Error('boom');
      },
    };
    const notFound = fake(() => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })));
    expect(await isTrustedApprover('u', { ...base, client: throwing })).toBe(false);
    expect(await isTrustedApprover('u', { ...base, client: fake(() => Promise.reject(new Error('x'))) })).toBe(false);
    expect(await isTrustedApprover('u', { ...base, client: notFound })).toBe(false);
  });

  it('never trusts an empty or whitespace login', async () => {
    const client = fake(async () => 'admin');
    expect(await isTrustedApprover('', { ...base, client })).toBe(false);
    expect(await isTrustedApprover('  ', { ...base, trustedApprovers: [''], client })).toBe(false);
    expect(client.getPermissionLevel).not.toHaveBeenCalled();
  });
});

describe('createOctokitCollaboratorPermissionClient', () => {
  it('returns the permission and passes input through', async () => {
    const get = vi.fn(async () => ({ data: { permission: 'admin' } }));
    const octokit: any = { rest: { repos: { getCollaboratorPermissionLevel: get } } };
    const client = createOctokitCollaboratorPermissionClient(octokit);
    expect(await client.getPermissionLevel({ owner: 'o', repo: 'r', username: 'u' })).toBe('admin');
    expect(get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', username: 'u' });
  });
});

describe('computeApprovalHash', () => {
  it('is sha256 hex of normalized title\\nbody', () => {
    const expected = createHash('sha256').update('T\na\nb\nc', 'utf8').digest('hex');
    expect(computeApprovalHash('T', 'a\r\nb\rc')).toBe(expected);
    expect(computeApprovalHash('T', 'a\nb\nc')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats null/undefined body as empty', () => {
    expect(computeApprovalHash('T', null)).toBe(computeApprovalHash('T', ''));
    expect(computeApprovalHash('T', undefined)).toBe(computeApprovalHash('T', ''));
  });

  it('changes on any title or body edit', () => {
    const h = computeApprovalHash('T', 'b');
    expect(computeApprovalHash('U', 'b')).not.toBe(h);
    expect(computeApprovalHash('T', 'c')).not.toBe(h);
    expect(computeApprovalHash('T', 'b ')).not.toBe(h);
  });
});

describe('approval comment', () => {
  it('carries the hidden marker, approver and short hash', () => {
    const hash = computeApprovalHash('T', 'B');
    const body = formatApprovalComment({ hash, lane: 'x', approver: 'alice' });
    expect(body).toContain(`<!-- factory-approval v1 sha256:${hash} lane:x -->`);
    expect(body).toContain('@alice');
    expect(body).toContain(hash.slice(0, 12));
  });

  it('slugs the lane', () => {
    expect(approvalMarker('abc', 'My Lane')).toBe('<!-- factory-approval v1 sha256:abc lane:my-lane -->');
  });
});

describe('approveIssues', () => {
  const setup = () => {
    const client = {
      getIssueContent: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
        title: 'T',
        body: `b${issue_number}`,
      })),
      createComment: vi.fn(async () => {}),
    } satisfies ApprovalGitHubClient;
    const enqueue = vi.fn(async (_lane: string, issues: readonly number[]): Promise<EnqueueResult[]> =>
      issues.map((issue, i) => ({ issue, outcome: 'queued' as const, position: i + 1 })),
    );
    const run = (issues: number[]) =>
      approveIssues({ owner: 'o', repo: 'r', lane: 'x', issues, approver: 'alice', client, enqueue });
    return { client, enqueue, run };
  };

  it('comments per issue with its own hash then enqueues once', async () => {
    const { client, enqueue, run } = setup();
    const res = await run([12, 14]);
    expect(client.createComment).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('x', [12, 14]);
    expect(res[0]).toEqual({ issue: 12, outcome: 'queued', hash: computeApprovalHash('T', 'b12'), position: 1 });
    expect(res[1].hash).toBe(computeApprovalHash('T', 'b14'));
    expect(res[0].hash).not.toBe(res[1].hash);
  });

  it('fails an issue whose read or comment fails and still queues the rest', async () => {
    const { client, enqueue, run } = setup();
    client.getIssueContent.mockRejectedValueOnce(new Error('read boom'));
    const res = await run([12, 14]);
    expect(res[0]).toEqual({ issue: 12, outcome: 'failed', detail: 'read boom' });
    expect(enqueue).toHaveBeenCalledWith('x', [14]);
    expect(res[1].outcome).toBe('queued');

    client.createComment.mockRejectedValueOnce('post boom');
    const res2 = await run([20, 21]);
    expect(res2[0]).toEqual({ issue: 20, outcome: 'failed', detail: 'post boom' });
    expect(enqueue).toHaveBeenLastCalledWith('x', [21]);
  });

  it('does not call enqueue when nothing was commented', async () => {
    const { client, enqueue, run } = setup();
    client.getIssueContent.mockRejectedValue(new Error('x'));
    const res = await run([1]);
    expect(res[0].outcome).toBe('failed');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('passes through already-queued and enqueue-reported failures', async () => {
    const { enqueue, run } = setup();
    enqueue.mockResolvedValueOnce([
      { issue: 12, outcome: 'already-queued' },
      { issue: 14, outcome: 'failed', detail: 'labels' },
    ]);
    const res = await run([12, 14]);
    expect(res[0]).toEqual({ issue: 12, outcome: 'already-queued', hash: computeApprovalHash('T', 'b12') });
    expect(res[1]).toMatchObject({ outcome: 'failed', detail: 'labels' });
  });

  it('marks commented issues failed when enqueue throws', async () => {
    const { enqueue, run } = setup();
    enqueue.mockRejectedValueOnce(new Error('queue down'));
    const res = await run([12]);
    expect(res[0]).toMatchObject({ issue: 12, outcome: 'failed', detail: 'queue down' });
    expect(res[0].hash).toBeDefined();
  });

  it('reports a missing enqueue result as failed', async () => {
    const { enqueue, run } = setup();
    enqueue.mockResolvedValueOnce([]);
    const res = await run([12]);
    expect(res[0]).toEqual({ issue: 12, outcome: 'failed', detail: 'no result' });
  });
});

describe('createOctokitApprovalClient', () => {
  it('maps to issues.get and issues.createComment', async () => {
    const get = vi.fn(async () => ({ data: { title: 'T', body: null } }));
    const createComment = vi.fn(async () => ({}));
    const client = createOctokitApprovalClient({ rest: { issues: { get, createComment } } } as never);
    const input = { owner: 'o', repo: 'r', issue_number: 1 };
    expect(await client.getIssueContent(input)).toEqual({ title: 'T', body: null });
    await client.createComment({ ...input, body: 'hi' });
    expect(get).toHaveBeenCalledWith(input);
    expect(createComment).toHaveBeenCalledWith({ ...input, body: 'hi' });
  });
});
