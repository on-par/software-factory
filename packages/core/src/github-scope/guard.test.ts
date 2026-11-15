import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';
import { createGitHubCredentialBroker, PhaseCredentialHolder, type GitHubCredentialSource } from './broker.js';
import { allowScopedMerge, GitHubScopeError, installGitHubScopeGuard, phaseHolderOf } from './guard.js';

const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
}

function setup(opts: { status?: number; initialPhase?: 'plan' | 'ship' | 'land' } = {}) {
  const seen: Seen[] = [];
  const fetchStub = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
    });
    return new Response(JSON.stringify({ message: 'denied', ok: true }), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const source: GitHubCredentialSource = {
    kind: 'fine-grained',
    async lease(phase) {
      return { phase, kind: 'fine-grained', token: `ghs_phasetoken_${phase}`, release: async () => {} };
    },
  };
  const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'Acme/Widgets', source }), {
    checkToken: () => 'ghp_checkambienttoken1',
    initialPhase: opts.initialPhase,
  });
  const octokit = installGitHubScopeGuard(new Octokit({ request: { fetch: fetchStub }, log: SILENT }), {
    repo: 'Acme/Widgets',
    holder,
  });
  return { octokit, holder, seen };
}

const getPull = (octokit: Octokit) => octokit.rest.pulls.get({ owner: 'acme', repo: 'widgets', pull_number: 1 });

const mergePr = (octokit: Octokit, repo = 'widgets') =>
  octokit.rest.pulls.merge({ owner: 'acme', repo, pull_number: 5 });

describe('GitHub scope guard', () => {
  it('refuses a merge from plan, build and ship credentials', async () => {
    const { octokit, holder, seen } = setup();
    for (const phase of ['plan', 'build', 'ship'] as const) {
      await holder.enter(phase);
      const failure = await mergePr(octokit).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(GitHubScopeError);
    }
    expect(seen).toEqual([]);
    await holder.enter('plan');
    const planMerge = await mergePr(octokit).catch((err: unknown) => err as Error);
    expect((planMerge as Error).message).toMatch(/only the land step may merge, after the trust-tier risk gate/);
  });

  it('allows a merge in the land phase only after allowScopedMerge', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('land');
    await expect(mergePr(octokit)).rejects.toBeInstanceOf(GitHubScopeError);
    expect(seen).toEqual([]);
    allowScopedMerge(octokit);
    await mergePr(octokit);
    expect(seen).toEqual([
      { method: 'PUT', path: '/repos/acme/widgets/pulls/5/merge', authorization: 'token ghs_phasetoken_land' },
    ]);
  });

  it('does not enable a merge outside the land phase or on unguarded clients', async () => {
    const { octokit, holder } = setup();
    await holder.enter('ship');
    allowScopedMerge(octokit);
    expect(holder.mergeAllowed).toBe(false);
    expect(() => allowScopedMerge(new Octokit())).not.toThrow();
    expect(() => allowScopedMerge(undefined)).not.toThrow();
    expect(phaseHolderOf(octokit)).toBe(holder);
    expect(phaseHolderOf('nope')).toBeUndefined();
  });

  it('refuses requests to a repository other than the target', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('ship');
    const failure = await octokit.rest.issues
      .get({ owner: 'acme', repo: 'other', issue_number: 1 })
      .catch((e: unknown) => e);
    expect((failure as Error).message).toContain('credential is scoped to Acme/Widgets');
    await octokit.rest.issues.get({ owner: 'ACME', repo: 'WIDGETS', issue_number: 1 });
    expect(seen).toHaveLength(1);
  });

  it('refuses every request during build with an actionable error', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('build');
    const failure = await octokit.rest.issues
      .get({ owner: 'acme', repo: 'widgets', issue_number: 1 })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitHubScopeError);
    expect((failure as GitHubScopeError).message).toContain('BUILD holds no GitHub credential');
    expect((failure as GitHubScopeError).fix).toContain('plan, ship or land');
    expect(seen).toEqual([]);
  });

  it('refuses plan writes outside issues but allows issue comments and graphql reads', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('plan');
    const pr = await octokit.rest.pulls
      .create({ owner: 'acme', repo: 'widgets', head: 'a', base: 'b', title: 't' })
      .catch((e: unknown) => e);
    expect((pr as Error).message).toContain('plan may only write issue comments and labels');
    await octokit.rest.issues.createComment({ owner: 'acme', repo: 'widgets', issue_number: 1, body: 'x' });
    await octokit.graphql('query { viewer { login } }');
    const mutation = await octokit
      .graphql('mutation { addStar(input: {}) { clientMutationId } }')
      .catch((e: unknown) => e);
    expect(mutation).toBeInstanceOf(GitHubScopeError);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /repos/acme/widgets/issues/1/comments',
      'POST /graphql',
    ]);
  });

  it('turns a 403 from GitHub into an actionable GitHubScopeError without retrying on the ambient token', async () => {
    const { octokit, holder, seen } = setup({ status: 403 });
    await holder.enter('ship');
    const failure = await getPull(octokit).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitHubScopeError);
    expect((failure as GitHubScopeError).message).toContain('403');
    expect((failure as GitHubScopeError).fix).toContain('contents:write');
    expect(seen.map((s) => s.authorization)).toEqual(['token ghs_phasetoken_ship']);
  });

  it('rethrows non-auth failures unchanged', async () => {
    const { octokit, holder } = setup({ status: 404 });
    await holder.enter('ship');
    const failure = await getPull(octokit).catch((e: unknown) => e);
    expect(failure).not.toBeInstanceOf(GitHubScopeError);
    expect((failure as { status?: number }).status).toBe(404);
  });

  it('refuses graphql mergePullRequest outside land', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('ship');
    const failure = await octokit
      .graphql('mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitHubScopeError);
    expect(seen).toEqual([]);
  });

  it('passes check-phase requests through on the existing credential', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('check');
    await mergePr(octokit, 'other');
    await octokit.rest.pulls.get({ owner: 'acme', repo: 'widgets', pull_number: 1 });
    expect(seen.map((s) => s.authorization)).toEqual(['token ghp_checkambienttoken1', 'token ghp_checkambienttoken1']);
  });

  it('sends check requests without authorization when no ambient token exists', async () => {
    const seen: Array<string | null> = [];
    const fetchStub = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      seen.push(new Request(String(input), init).headers.get('authorization'));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    const source: GitHubCredentialSource = {
      kind: 'fine-grained',
      lease: async () => {
        throw new Error('unused');
      },
    };
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'a/b', source }), {
      checkToken: () => undefined,
    });
    const octokit = installGitHubScopeGuard(new Octokit({ request: { fetch: fetchStub }, log: SILENT }), {
      repo: 'a/b',
      holder,
    });
    await holder.enter('check');
    await octokit.rest.pulls.get({ owner: 'a', repo: 'b', pull_number: 1 });
    expect(seen).toEqual([null]);
  });

  it('injects the phase token into the authorization header and enters the initial phase lazily', async () => {
    const { octokit, holder, seen } = setup({ initialPhase: 'ship' });
    expect(holder.current()).toBeUndefined();
    await octokit.rest.pulls.get({ owner: 'acme', repo: 'widgets', pull_number: 1 });
    expect(holder.current()?.phase).toBe('ship');
    expect(seen[0]?.authorization).toBe('token ghs_phasetoken_ship');
    await holder.enter('plan');
    await octokit.rest.issues.get({ owner: 'acme', repo: 'widgets', issue_number: 1 });
    expect(seen[1]?.authorization).toBe('token ghs_phasetoken_plan');
  });

  it('throws the stored lease failure on every request', async () => {
    const source: GitHubCredentialSource = {
      kind: 'fine-grained',
      lease: async (phase) => {
        throw new GitHubScopeError(phase, '', '', 'no token', 'set it');
      },
    };
    const holder = new PhaseCredentialHolder(createGitHubCredentialBroker({ repo: 'a/b', source }), {
      checkToken: () => undefined,
    });
    const octokit = installGitHubScopeGuard(new Octokit({ log: SILENT }), { repo: 'a/b', holder });
    await holder.enter('ship');
    const failure = await octokit.rest.pulls.get({ owner: 'a', repo: 'b', pull_number: 1 }).catch((e: unknown) => e);
    expect((failure as Error).message).toContain('no token');
  });

  it('refuses requests after the holder is closed', async () => {
    const { octokit, holder, seen } = setup();
    await holder.enter('ship');
    await holder.close();
    const failure = await getPull(octokit).catch((e: unknown) => e);
    expect((failure as Error).message).toContain('no credential leased');
    expect(seen).toEqual([]);
  });

  it('never includes the token in a GitHubScopeError message', () => {
    const token = 'ghs_secretminted1234567890';
    const error = new GitHubScopeError('ship', 'GET', `/repos/o/r?access=${token}`, `bad ${token}`, `rotate ${token}`);
    expect(error.message).not.toContain(token);
    expect(error.message).toContain('[redacted]');
  });
});
