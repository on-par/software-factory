import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ambientSource,
  createGitHubCredentialBroker,
  fineGrainedSource,
  PhaseCredentialHolder,
  resolveGitHubCredentialSource,
} from './broker.js';
import { GitHubScopeError } from './errors.js';
import { scopeForPhase } from './matrix.js';
import type { GitHubCredentialSource, PhaseCredential } from './types.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const APP = { appId: 7, installationId: 9 };

const bodyText = (body: unknown): string => (typeof body === 'string' ? body : '');

function mintingFetch(): { fetch: typeof fetch; bodies: unknown[]; deleted: string[] } {
  const bodies: unknown[] = [];
  const deleted: string[] = [];
  let counter = 0;
  const stub = async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (init?.method === 'DELETE') {
      deleted.push(String((init.headers as Record<string, string>)['Authorization']));
      return new Response(null, { status: 204 });
    }
    bodies.push(JSON.parse(bodyText(init?.body)));
    counter += 1;
    return new Response(JSON.stringify({ token: `ghs_minted${counter}abcdefgh` }), { status: 201 });
  };
  return { fetch: stub, bodies, deleted };
}

function appSource() {
  const minting = mintingFetch();
  const { source } = resolveGitHubCredentialSource(
    { allowAmbientToken: false, app: APP },
    { FACTORY_GITHUB_APP_PRIVATE_KEY: privateKey },
    () => undefined,
    { fetch: minting.fetch },
  );
  return { minting, source };
}

function recordingSource(): { source: GitHubCredentialSource; events: string[] } {
  const events: string[] = [];
  const source: GitHubCredentialSource = {
    kind: 'fine-grained',
    async lease(phase): Promise<PhaseCredential> {
      events.push(`lease:${phase}`);
      return {
        phase,
        kind: 'fine-grained',
        token: `tok-${phase}`,
        async release() {
          events.push(`release:${phase}`);
        },
      };
    },
  };
  return { source, events };
}

describe('credential source resolution', () => {
  it('mints an app installation token scoped to the target repo and phase permissions', async () => {
    const { minting, source } = appSource();
    const broker = createGitHubCredentialBroker({ repo: 'acme/widgets', source });
    const credential = await broker.lease('plan');
    expect(credential?.token).toBe('ghs_minted1abcdefgh');
    expect(minting.bodies).toEqual([{ repositories: ['widgets'], permissions: scopeForPhase('plan')!.permissions }]);
  });

  it('prefers the app installation source over fine-grained tokens', () => {
    const resolved = resolveGitHubCredentialSource(
      { allowAmbientToken: true, app: APP },
      { FACTORY_GITHUB_APP_PRIVATE_KEY: privateKey, FACTORY_GITHUB_TOKEN_SHIP: 'github_pat_x' },
      () => 'ambient-token',
    );
    expect(resolved.source.kind).toBe('app-installation');
    expect(resolved.warning).toBeUndefined();
  });

  it('uses the per-phase fine-grained token as the fallback source', async () => {
    const { source } = resolveGitHubCredentialSource(
      { allowAmbientToken: false },
      { FACTORY_GITHUB_TOKEN_SHIP: ' github_pat_ship ' },
      () => 'ambient-token',
    );
    expect(source.kind).toBe('fine-grained');
    const credential = await createGitHubCredentialBroker({ repo: 'o/r', source }).lease('ship');
    expect(credential?.token).toBe('github_pat_ship');
  });

  it('fails closed when the fine-grained token for a phase is missing', async () => {
    const source = fineGrainedSource({ FACTORY_GITHUB_TOKEN_PLAN: 'github_pat_plan', FACTORY_GITHUB_TOKEN_LAND: ' ' });
    const failure = await source.lease('land', 'o/r', scopeForPhase('land')!).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GitHubScopeError);
    expect((failure as Error).message).toContain('phase land has no GitHub credential');
    expect((failure as Error).message).toContain('FACTORY_GITHUB_TOKEN_LAND');
    expect((failure as Error).message).toContain('contents:write');
  });

  it('never falls back to the ambient token when a scoped source is configured', async () => {
    const ambient = 'ghp_ambientoperatortoken1234';
    const appWithoutKey = resolveGitHubCredentialSource({ allowAmbientToken: true, app: APP }, {}, () => ambient);
    const holder = new PhaseCredentialHolder(
      createGitHubCredentialBroker({ repo: 'o/r', source: appWithoutKey.source }),
      {
        checkToken: () => ambient,
      },
    );
    await holder.enter('ship');
    const state = holder.current();
    expect(state?.credential).toBeUndefined();
    expect(state?.failure?.message).toContain('FACTORY_GITHUB_APP_PRIVATE_KEY');
    expect(state?.failure?.message).not.toContain(ambient);
    expect(appWithoutKey.source.kind).toBe('app-installation');

    const fineGrainedMissing = resolveGitHubCredentialSource(
      { allowAmbientToken: true },
      { FACTORY_GITHUB_TOKEN_PLAN: 'github_pat_plan' },
      () => ambient,
    );
    const second = new PhaseCredentialHolder(
      createGitHubCredentialBroker({ repo: 'o/r', source: fineGrainedMissing.source }),
      { checkToken: () => ambient },
    );
    await second.enter('ship');
    expect(second.current()?.credential).toBeUndefined();
    expect(second.current()?.failure).toBeInstanceOf(GitHubScopeError);
  });

  it('uses the ambient token only with allowAmbientToken and reports the opt-in warning', async () => {
    const optIn = resolveGitHubCredentialSource({ allowAmbientToken: true }, {}, () => 'ambient-token');
    expect(optIn.source).toMatchObject({ kind: 'ambient', ambientReason: 'opt-in' });
    expect(optIn.warning).toBe('ambient operator GitHub token in use (github.credentials.allowAmbientToken)');
    const unconfigured = resolveGitHubCredentialSource({ allowAmbientToken: false }, {}, () => 'ambient-token');
    expect(unconfigured.source).toMatchObject({ kind: 'ambient', ambientReason: 'unconfigured' });
    expect(unconfigured.warning).toContain('ADR-0160');
    const credential = await createGitHubCredentialBroker({ repo: 'o/r', source: optIn.source }).lease('plan');
    expect(credential?.token).toBe('ambient-token');
  });

  it('fails when the ambient resolver yields nothing', async () => {
    const source = ambientSource(() => undefined, 'opt-in');
    await expect(source.lease('plan', 'o/r', scopeForPhase('plan')!)).rejects.toBeInstanceOf(GitHubScopeError);
  });

  it('leases no credential for the build phase', async () => {
    const { source, events } = recordingSource();
    const broker = createGitHubCredentialBroker({ repo: 'o/r', source });
    expect(await broker.lease('build')).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('PhaseCredentialHolder', () => {
  it('revokes the previous phase token when the next phase begins', async () => {
    const { minting, source } = appSource();
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'o/r', source }), {
      checkToken: () => undefined,
    });
    await holder.enter('plan');
    expect(holder.current()?.credential?.token).toBe('ghs_minted1abcdefgh');
    await holder.enter('build');
    expect(minting.deleted).toEqual(['token ghs_minted1abcdefgh']);
    expect(holder.current()).toEqual({ phase: 'build', mode: 'none' });
    await holder.enter('ship');
    expect(holder.current()?.credential?.token).toBe('ghs_minted2abcdefgh');
    await holder.close();
    expect(minting.deleted).toEqual(['token ghs_minted1abcdefgh', 'token ghs_minted2abcdefgh']);
  });

  it('releases before leasing the next credential and passes check through', async () => {
    const { source, events } = recordingSource();
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'o/r', source }), {
      checkToken: () => ' ambient ',
    });
    await holder.enter('plan');
    await holder.enter('check');
    expect(holder.current()).toEqual({ phase: 'check', mode: 'passthrough' });
    expect(holder.checkToken()).toBe('ambient');
    await holder.enter('ship');
    expect(events).toEqual(['lease:plan', 'release:plan', 'lease:ship']);
  });

  it('resets mergeAllowed on every phase entry', async () => {
    const { source } = recordingSource();
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'o/r', source }), {
      checkToken: () => undefined,
      initialPhase: 'land',
    });
    await holder.ensureEntered();
    expect(holder.current()?.phase).toBe('land');
    holder.mergeAllowed = true;
    await holder.enter('ship');
    expect(holder.mergeAllowed).toBe(false);
  });

  it('enters the initial phase once for concurrent callers', async () => {
    const { source, events } = recordingSource();
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'o/r', source }), {
      checkToken: () => undefined,
    });
    await Promise.all([holder.ensureEntered(), holder.ensureEntered()]);
    expect(events).toEqual(['lease:plan']);
  });

  it('records a non-Error lease failure as an Error', async () => {
    const source: GitHubCredentialSource = {
      kind: 'fine-grained',
      async lease() {
        throw 'boom';
      },
    };
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'o/r', source }), {
      checkToken: () => undefined,
    });
    await holder.enter('plan');
    expect(holder.current()?.failure?.message).toBe('boom');
  });
});
