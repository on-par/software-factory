import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { loadFactoryConfig } from '../config/index.js';
import {
  computeApprovalHash,
  createOctokitCollaboratorPermissionClient,
  isTrustedApprover,
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
  it('is lowercase sha256 hex of "title\\nbody"', () => {
    const h = computeApprovalHash({ title: 't', body: 'b' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash('sha256').update('t\nb', 'utf8').digest('hex'));
  });

  it('treats CRLF, CR and LF alike', () => {
    const lf = computeApprovalHash({ title: 't', body: 'a\nb' });
    expect(computeApprovalHash({ title: 't', body: 'a\r\nb' })).toBe(lf);
    expect(computeApprovalHash({ title: 't', body: 'a\rb' })).toBe(lf);
  });

  it('changes with the body, the title and trailing whitespace', () => {
    const h = computeApprovalHash({ title: 't', body: 'abc' });
    expect(computeApprovalHash({ title: 't', body: 'abd' })).not.toBe(h);
    expect(computeApprovalHash({ title: 'u', body: 'abc' })).not.toBe(h);
    expect(computeApprovalHash({ title: 't', body: 'abc ' })).not.toBe(h);
  });
});
