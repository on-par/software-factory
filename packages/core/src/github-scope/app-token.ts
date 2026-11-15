import { createSign } from 'node:crypto';

import { GitHubScopeError } from './guard.js';
import type { GitHubCredentialSource, PhaseCredential } from './broker.js';
import { permissionList, type GitHubPhase, type PhaseGitHubScope } from './matrix.js';

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const API_VERSION_ACCEPT = 'application/vnd.github+json';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function createAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: issuedAt - JWT_BACKDATE_SECONDS, exp: issuedAt + JWT_LIFETIME_SECONDS, iss: appId }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${base64url(signature)}`;
}

function mintFix(repoName: string, scope: PhaseGitHubScope): string {
  return `grant the App ${permissionList(scope)} on ${repoName} and install it there`;
}

export function appInstallationSource(opts: {
  appId: number;
  installationId: number;
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  apiBase?: string;
}): GitHubCredentialSource {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const apiBase = opts.apiBase ?? 'https://api.github.com';
  return {
    kind: 'app-installation',
    async lease(phase: GitHubPhase, repo: string, scope: PhaseGitHubScope): Promise<PhaseCredential> {
      const repoName = repo.split('/')[1] ?? repo;
      const response = await doFetch(`${apiBase}/app/installations/${opts.installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${createAppJwt(opts.appId, opts.privateKey, now())}`,
          Accept: API_VERSION_ACCEPT,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repositories: [repoName], permissions: scope.permissions }),
      });
      const parsed: unknown = response.status === 201 ? await response.json().catch(() => undefined) : undefined;
      const minted = parsed as { token?: unknown; expires_at?: unknown } | undefined;
      if (typeof minted?.token !== 'string' || minted.token === '') {
        throw new GitHubScopeError(
          phase,
          '',
          '',
          `GitHub App token mint for ${repo} failed with status ${response.status}`,
          mintFix(repoName, scope),
        );
      }
      const token = minted.token;
      return {
        phase,
        kind: 'app-installation',
        token,
        expiresAt: typeof minted.expires_at === 'string' ? minted.expires_at : undefined,
        async release() {
          await doFetch(`${apiBase}/installation/token`, {
            method: 'DELETE',
            headers: { Authorization: `token ${token}`, Accept: API_VERSION_ACCEPT },
          }).catch(() => undefined);
        },
      };
    },
  };
}
