import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appInstallationSource, createAppJwt } from './app-token.js';
import { GitHubScopeError } from './errors.js';
import { scopeForPhase } from './matrix.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(status: number, payload: unknown): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const stub = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  };
  return { fetch: stub, calls };
}

const plan = scopeForPhase('plan');

describe('createAppJwt', () => {
  it('verifies with the matching public key and carries the app claims', () => {
    const now = 1_700_000_000_000;
    const jwt = createAppJwt(42, privateKey, now);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
    expect(verifier.verify(createPublicKey(publicKey), Buffer.from(signature ?? '', 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: 42,
    });
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
  });
});

describe('appInstallationSource', () => {
  it('throws a GitHubScopeError without the JWT when the mint is refused', async () => {
    const { fetch, calls } = stubFetch(403, { message: 'Resource not accessible' });
    const source = appInstallationSource({ appId: 1, installationId: 2, privateKey, fetch });
    const failure = await source.lease('plan', 'o/r', plan!).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GitHubScopeError);
    const message = (failure as Error).message;
    const jwt = calls[0]?.headers['Authorization']?.replace('Bearer ', '') ?? '';
    expect(jwt.length).toBeGreaterThan(20);
    expect(message).not.toContain(jwt);
    expect(message).toContain('403');
    expect(message).toContain('grant the App');
    expect(message).toContain('on r');
  });

  it('throws when a 201 carries no token', async () => {
    const { fetch } = stubFetch(201, {});
    const source = appInstallationSource({ appId: 1, installationId: 2, privateKey, fetch });
    await expect(source.lease('plan', 'o/r', plan!)).rejects.toBeInstanceOf(GitHubScopeError);
  });

  it('mints with repositories and permissions and releases with DELETE /installation/token', async () => {
    const { fetch, calls } = stubFetch(201, { token: 'ghs_minted1234567890', expires_at: '2030-01-01T00:00:00Z' });
    const source = appInstallationSource({
      appId: 1,
      installationId: 2,
      privateKey,
      fetch,
      apiBase: 'https://gh.test',
    });
    const credential = await source.lease('plan', 'o/r', plan!);
    expect(calls[0]).toMatchObject({
      url: 'https://gh.test/app/installations/2/access_tokens',
      method: 'POST',
      body: { repositories: ['r'], permissions: plan!.permissions },
    });
    expect(credential).toMatchObject({ token: 'ghs_minted1234567890', expiresAt: '2030-01-01T00:00:00Z' });
    await credential.release();
    expect(calls[1]).toMatchObject({
      url: 'https://gh.test/installation/token',
      method: 'DELETE',
      headers: { Authorization: 'token ghs_minted1234567890' },
    });
  });

  it('swallows a failing release', async () => {
    let first = true;
    const failingFetch = async (): Promise<Response> => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ token: 'ghs_abcdefgh12345' }), { status: 201 });
      }
      throw new Error('network down');
    };
    const source = appInstallationSource({ appId: 1, installationId: 2, privateKey, fetch: failingFetch });
    const credential = await source.lease('ship', 'o/r', scopeForPhase('ship')!);
    await expect(credential.release()).resolves.toBeUndefined();
  });
});

describe('appInstallationSource release failure', () => {
  it('reports a failed token revoke through onReleaseError', async () => {
    const errors: unknown[] = [];
    let call = 0;
    const source = appInstallationSource({
      appId: 1,
      installationId: 2,
      privateKey,
      onReleaseError: (_phase, err) => errors.push(err),
      fetch: (async () => {
        call += 1;
        if (call === 1) return new Response(JSON.stringify({ token: 'ghs_x' }), { status: 201 });
        throw new Error('network down');
      }) as typeof fetch,
    });
    const credential = await source.lease('ship', 'o/r', scopeForPhase('ship')!);
    await credential.release();
    expect(errors).toHaveLength(1);
  });
});
