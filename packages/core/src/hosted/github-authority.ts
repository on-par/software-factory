// src/hosted/github-authority.ts — Brokers a per-job, single-repo GitHub
// credential for hosted-exec containers (#901, parent #895/#897/#898/#899/#900).
// Core stays hermetic: the raw token is minted through an injected
// MintGitHubToken port, never fetched or written to disk here. Gated by
// FACTORY_HOSTED_EXEC so the local factory path (which uses its own ambient
// GitHub auth) is completely untouched when hosted exec is off.
import { hostedExecEnabled } from '@on-par/contracts';

import { redactSecrets } from '../router/failure-detail.js';
import type { HostedClock, StoredHostedJob } from './store.js';

export type GitHubTokenKind = 'installation' | 'prototype-fallback';

export interface MintGitHubTokenInput {
  jobId: string;
  repoSlug: string;
  requiredAuthority: string;
}

export interface MintedGitHubToken {
  token: string;
  kind: GitHubTokenKind;
  username?: string;
  expiresAt?: string;
}

export type MintGitHubToken = (input: MintGitHubTokenInput) => Promise<MintedGitHubToken>;

export interface GitHubCredentialBundle {
  jobId: string;
  repoSlug: string;
  kind: GitHubTokenKind;
  username: string;
  token: string;
  /** Authenticated clone URL, e.g. https://x-access-token:<token>@github.com/<repoSlug>.git */
  remoteUrl: string;
  /** git-credentials store line, e.g. https://x-access-token:<token>@github.com */
  credentialLine: string;
  /** Path inside the container the credential file is mounted at. */
  containerCredentialPath: string;
  createdAt: string;
  expiresAt?: string;
}

export interface GitHubAuthorityBrokerOptions {
  mint: MintGitHubToken;
  now: HostedClock;
  /** default '/workspace/.git-credentials' */
  containerCredentialPath?: string;
}

/** Mints and shapes a per-job, single-repo GitHub credential bundle. Never
 * logs the raw token — callers must scrub with redactGitHubCredential before
 * the token can reach any event, log, or trace. */
export async function prepareGitHubAuthority(
  job: StoredHostedJob,
  options: GitHubAuthorityBrokerOptions,
): Promise<GitHubCredentialBundle> {
  const minted = await options.mint({
    jobId: job.request.jobId,
    repoSlug: job.request.repoSlug,
    requiredAuthority: job.request.requiredAuthority,
  });
  const username = minted.username ?? 'x-access-token';
  const containerCredentialPath = options.containerCredentialPath ?? '/workspace/.git-credentials';
  return {
    jobId: job.request.jobId,
    repoSlug: job.request.repoSlug,
    kind: minted.kind,
    username,
    token: minted.token,
    remoteUrl: `https://${username}:${minted.token}@github.com/${job.request.repoSlug}.git`,
    credentialLine: `https://${username}:${minted.token}@github.com`,
    containerCredentialPath,
    createdAt: new Date(options.now()).toISOString(),
    expiresAt: minted.expiresAt,
  };
}

/** AC#5 off-switch: returns null (no broker/mint runs) unless
 * FACTORY_HOSTED_EXEC is exactly '1', so the local factory path keeps using
 * its own existing GitHub auth unchanged. */
export async function resolveHostedAuthority(
  env: NodeJS.ProcessEnv,
  job: StoredHostedJob,
  options: GitHubAuthorityBrokerOptions,
): Promise<GitHubCredentialBundle | null> {
  if (!hostedExecEnabled(env)) return null;
  return prepareGitHubAuthority(job, options);
}

/** Scrubs a credential bundle's raw token out of arbitrary text: known
 * patterns via redactSecrets, then an exact splice of the minted token so an
 * arbitrary prototype-fallback token (which may match no known pattern) is
 * still guaranteed to be masked. */
export function redactGitHubCredential(text: string, bundle: GitHubCredentialBundle): string {
  const sanitized = redactSecrets(text);
  if (!bundle.token) return sanitized;
  return sanitized.split(bundle.token).join('[redacted]');
}

/** The first prototype's local minter: marks every token it hands out as
 * kind: 'prototype-fallback' — never silently treated as a scoped GitHub App
 * installation token. */
export function prototypeFallbackMint(token: string): MintGitHubToken {
  return async () => ({ token, kind: 'prototype-fallback', username: 'x-access-token' });
}
