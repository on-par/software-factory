import { describe, expect, it } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { loadFactoryConfig } from '../config/index.js';
import {
  createOctokitCollaboratorPermissionClient,
  isTrustedApprover,
  type CollaboratorPermissionClient,
} from './approval.js';

const base = { owner: 'o', repo: 'r' };
const fake = (impl: () => Promise<string>) => {
  const lookups: Array<{ owner: string; repo: string; username: string }> = [];
  const client = {
    getPermissionLevel: async (input: { owner: string; repo: string; username: string }) => {
      lookups.push(input);
      return impl();
    },
  } satisfies CollaboratorPermissionClient;
  return { client, lookups };
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
    const { client, lookups } = fake(async () => 'admin');
    const opts = { ...base, trustedApprovers: ['patrob'], client };
    expect(await isTrustedApprover('patrob', opts)).toBe(true);
    expect(await isTrustedApprover('PatRob', opts)).toBe(true);
    expect(await isTrustedApprover('someone-else', opts)).toBe(false);
    expect(lookups).toEqual([]);
  });

  it('trusts nobody for an explicit empty list', async () => {
    const { client, lookups } = fake(async () => 'admin');
    expect(await isTrustedApprover('patrob', { ...base, trustedApprovers: [], client })).toBe(false);
    expect(lookups).toEqual([]);
  });

  it('falls back to admin permission when the list is unset', async () => {
    const admin = fake(async () => 'admin');
    expect(await isTrustedApprover('u', { ...base, client: admin.client })).toBe(true);
    expect(admin.lookups).toEqual([{ owner: 'o', repo: 'r', username: 'u' }]);
    for (const level of ['write', 'read', 'none', 'maintain']) {
      expect(await isTrustedApprover('u', { ...base, client: fake(async () => level).client })).toBe(false);
    }
  });

  it('fails closed on lookup errors', async () => {
    const throwing: CollaboratorPermissionClient = {
      getPermissionLevel: () => {
        throw new Error('boom');
      },
    };
    const notFound = fake(() => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))).client;
    expect(await isTrustedApprover('u', { ...base, client: throwing })).toBe(false);
    expect(await isTrustedApprover('u', { ...base, client: fake(() => Promise.reject(new Error('x'))).client })).toBe(
      false,
    );
    expect(await isTrustedApprover('u', { ...base, client: notFound })).toBe(false);
  });

  it('never trusts an empty or whitespace login', async () => {
    const { client, lookups } = fake(async () => 'admin');
    expect(await isTrustedApprover('', { ...base, client })).toBe(false);
    expect(await isTrustedApprover('  ', { ...base, trustedApprovers: [''], client })).toBe(false);
    expect(lookups).toEqual([]);
  });
});

describe('createOctokitCollaboratorPermissionClient', () => {
  it('returns the permission and passes input through', async () => {
    const inputs: unknown[] = [];
    const get = async (input: unknown) => {
      inputs.push(input);
      return { data: { permission: 'admin' } };
    };
    const octokit: any = { rest: { repos: { getCollaboratorPermissionLevel: get } } };
    const client = createOctokitCollaboratorPermissionClient(octokit);
    expect(await client.getPermissionLevel({ owner: 'o', repo: 'r', username: 'u' })).toBe('admin');
    expect(inputs).toEqual([{ owner: 'o', repo: 'r', username: 'u' }]);
  });
});
