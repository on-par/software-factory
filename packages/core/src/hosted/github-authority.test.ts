import { describe, expect, it, vi } from 'vitest';

import {
  prepareGitHubAuthority,
  prototypeFallbackMint,
  redactGitHubCredential,
  resolveHostedAuthority,
  type GitHubAuthorityBrokerOptions,
  type MintGitHubToken,
} from './github-authority.js';
import { createHostedJobStore, type StoredHostedJob } from './store.js';

function jobFor(repoSlug: string): StoredHostedJob {
  const store = createHostedJobStore({ now: () => 1_000 });
  return store.create({
    jobId: 'job-1',
    repoSlug,
    taskPayload: 'run the build',
    requiredCapabilities: ['git', 'node'],
    requiredAuthority: 'repo:write',
  });
}

describe('prepareGitHubAuthority', () => {
  it('scopes a fallback bundle to exactly the job repo and marks it prototype-fallback (AC#1)', async () => {
    const job = jobFor('on-par/sound-buddy');
    const options: GitHubAuthorityBrokerOptions = { mint: prototypeFallbackMint('local-tok'), now: () => 2_000 };

    const bundle = await prepareGitHubAuthority(job, options);

    expect(bundle.kind).toBe('prototype-fallback');
    expect(bundle.repoSlug).toBe('on-par/sound-buddy');
    expect(bundle.remoteUrl).toContain('on-par/sound-buddy');
    expect(bundle.remoteUrl).not.toContain('some-other-repo');
  });

  it('shapes an installation-token bundle the same way (App path shape)', async () => {
    const job = jobFor('on-par/sound-buddy');
    const mint: MintGitHubToken = async () => ({ token: 'app-tok', kind: 'installation', username: 'x-access-token' });
    const options: GitHubAuthorityBrokerOptions = { mint, now: () => 2_000 };

    const bundle = await prepareGitHubAuthority(job, options);

    expect(bundle.kind).toBe('installation');
    expect(bundle.token).toBe('app-tok');
  });

  it('embeds the minted token and x-access-token username into remoteUrl/credentialLine (AC#2)', async () => {
    const job = jobFor('on-par/sound-buddy');
    const options: GitHubAuthorityBrokerOptions = { mint: prototypeFallbackMint('local-tok'), now: () => 2_000 };

    const bundle = await prepareGitHubAuthority(job, options);

    expect(bundle.remoteUrl).toBe('https://x-access-token:local-tok@github.com/on-par/sound-buddy.git');
    expect(bundle.credentialLine).toBe('https://x-access-token:local-tok@github.com');
    expect(bundle.containerCredentialPath).toBe('/workspace/.git-credentials');
    expect(bundle.createdAt).toBe(new Date(2_000).toISOString());
  });

  it('honors a custom containerCredentialPath', async () => {
    const job = jobFor('on-par/sound-buddy');
    const options: GitHubAuthorityBrokerOptions = {
      mint: prototypeFallbackMint('local-tok'),
      now: () => 2_000,
      containerCredentialPath: '/workspace/custom-creds',
    };

    const bundle = await prepareGitHubAuthority(job, options);

    expect(bundle.containerCredentialPath).toBe('/workspace/custom-creds');
  });
});

describe('redactGitHubCredential', () => {
  it('masks the exact minted token even when it matches no known secret pattern (AC#3)', async () => {
    const job = jobFor('o/r');
    const options: GitHubAuthorityBrokerOptions = { mint: prototypeFallbackMint('local-tok'), now: () => 2_000 };
    const bundle = await prepareGitHubAuthority(job, options);

    const redacted = redactGitHubCredential('cloning https://x-access-token:local-tok@github.com/o/r.git', bundle);

    expect(redacted).not.toContain('local-tok');
    expect(redacted).toContain('[redacted]');
  });

  it('masks an arbitrary fallback token that looks nothing like a known token format', async () => {
    const job = jobFor('o/r');
    const options: GitHubAuthorityBrokerOptions = {
      mint: prototypeFallbackMint('totally-arbitrary-string-42'),
      now: () => 2_000,
    };
    const bundle = await prepareGitHubAuthority(job, options);

    const redacted = redactGitHubCredential('token was totally-arbitrary-string-42 during clone', bundle);

    expect(redacted).not.toContain('totally-arbitrary-string-42');
  });

  it('still applies known-pattern redaction alongside the exact-token splice', async () => {
    const job = jobFor('o/r');
    const options: GitHubAuthorityBrokerOptions = { mint: prototypeFallbackMint('local-tok'), now: () => 2_000 };
    const bundle = await prepareGitHubAuthority(job, options);

    const redacted = redactGitHubCredential('leaked ghp_abcdefghijklmnopqrstuvwx and local-tok', bundle);

    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
    expect(redacted).not.toContain('local-tok');
  });
});

describe('resolveHostedAuthority (AC#5 off-switch)', () => {
  it('resolves null and never calls mint when FACTORY_HOSTED_EXEC is unset', async () => {
    const job = jobFor('o/r');
    const mint = vi.fn<MintGitHubToken>(async () => ({ token: 't', kind: 'prototype-fallback' }));
    const options: GitHubAuthorityBrokerOptions = { mint, now: () => 2_000 };

    const bundle = await resolveHostedAuthority({}, job, options);

    expect(bundle).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it('resolves a bundle when FACTORY_HOSTED_EXEC is exactly 1', async () => {
    const job = jobFor('o/r');
    const options: GitHubAuthorityBrokerOptions = { mint: prototypeFallbackMint('local-tok'), now: () => 2_000 };

    const bundle = await resolveHostedAuthority({ FACTORY_HOSTED_EXEC: '1' }, job, options);

    expect(bundle?.kind).toBe('prototype-fallback');
  });

  it('treats any non-"1" value as off', async () => {
    const job = jobFor('o/r');
    const mint = vi.fn<MintGitHubToken>(async () => ({ token: 't', kind: 'prototype-fallback' }));
    const options: GitHubAuthorityBrokerOptions = { mint, now: () => 2_000 };

    const bundle = await resolveHostedAuthority({ FACTORY_HOSTED_EXEC: 'true' }, job, options);

    expect(bundle).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });
});
