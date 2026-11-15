import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { phaseHolderOf } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalOctokit, createScopedFactoryOctokit, credentialSourceOf, type LocalShell } from './github-scope.js';

const AMBIENT = 'ghp_ambientoperatortoken0001';
const seen: Array<string | null> = [];

function stubFetch(): void {
  seen.length = 0;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push(new Request(String(input), init).headers.get('authorization'));
    return new Response('{"title":"x"}', { headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const getIssue = (octokit: ReturnType<typeof createScopedFactoryOctokit>['octokit'], repo = 'widgets') =>
  octokit.rest.issues.get({ owner: 'acme', repo, issue_number: 1 });

describe('createScopedFactoryOctokit', () => {
  it('builds a phase-scoped client with no ambient token re-read', async () => {
    stubFetch();
    const { octokit, source } = createScopedFactoryOctokit({
      repo: 'acme/widgets',
      phase: 'ship',
      settings: { allowAmbientToken: false },
      env: { FACTORY_GITHUB_TOKEN_SHIP: 'github_pat_ship_value' },
      resolveAmbient: () => AMBIENT,
      options: { throttle: false },
    });
    expect(source.source.kind).toBe('fine-grained');
    await getIssue(octokit);
    expect(seen).toEqual(['token github_pat_ship_value']);
    const failure = await getIssue(octokit, 'other').catch((err: unknown) => err);
    expect((failure as Error).message).toContain('credential is scoped to acme/widgets');
    expect(seen).toEqual(['token github_pat_ship_value']);
    expect(phaseHolderOf(octokit)?.current()?.phase).toBe('ship');
  });

  it('fails closed with no ambient fallback when the phase token is missing', async () => {
    stubFetch();
    const { octokit } = createScopedFactoryOctokit({
      repo: 'acme/widgets',
      phase: 'land',
      settings: { allowAmbientToken: true },
      env: { FACTORY_GITHUB_TOKEN_PLAN: 'github_pat_plan_value' },
      resolveAmbient: () => AMBIENT,
      options: { throttle: false, resolveToken: () => AMBIENT },
    });
    const failure = await getIssue(octokit).catch((err: unknown) => err);
    expect((failure as Error).message).toContain('FACTORY_GITHUB_TOKEN_LAND');
    expect(seen).toEqual([]);
  });

  it('returns the legacy client for the ambient source', async () => {
    stubFetch();
    const { octokit, source } = createScopedFactoryOctokit({
      repo: 'acme/widgets',
      phase: 'plan',
      settings: { allowAmbientToken: true },
      env: {},
      resolveAmbient: () => AMBIENT,
      options: { throttle: false },
    });
    await getIssue(octokit, 'other');
    expect(seen).toEqual([`token ${AMBIENT}`]);
    expect(phaseHolderOf(octokit)).toBeUndefined();
    expect(source.source).toMatchObject({ kind: 'ambient', ambientReason: 'opt-in' });
    expect(credentialSourceOf(octokit)).toBe(source);
    expect(credentialSourceOf('nope')).toBeUndefined();
  });
});

describe('createLocalOctokit', () => {
  const shellWith = (remote: string | undefined): LocalShell => ({
    execSync: (command) => {
      if (command.includes('remote get-url') && remote) return `${remote}\n`;
      if (command.includes('show-toplevel')) return '/nonexistent/repo\n';
      throw new Error('unavailable');
    },
  });
  const env = { FACTORY_GITHUB_TOKEN_SHIP: 'github_pat_ship_value' };

  it('keeps the legacy client when neither a repo nor a phase is known', () => {
    const octokit = createLocalOctokit(shellWith('git@github.com:acme/widgets.git'), () => AMBIENT, env, {});
    expect(phaseHolderOf(octokit)).toBeUndefined();
  });

  it('scopes a land client to the repo parsed from the origin remote', async () => {
    stubFetch();
    const octokit = createLocalOctokit(shellWith('git@github.com:acme/widgets.git'), () => AMBIENT, env, {
      phase: 'ship',
      throttle: false,
    });
    expect(phaseHolderOf(octokit)).toBeDefined();
    await getIssue(octokit);
    expect(seen).toEqual(['token github_pat_ship_value']);
  });

  it('throws when a phase is requested and the remote is not a GitHub repo', () => {
    const run = (remote: string | undefined) => () =>
      createLocalOctokit(shellWith(remote), () => AMBIENT, env, { phase: 'land' });
    expect(run('https://example.com/x.git')).toThrow(/origin remote/);
    expect(run(undefined)).toThrow(/origin remote/);
  });

  it('throws when a phase is requested and the repo root cannot be resolved', () => {
    const shell: LocalShell = {
      execSync: (command) => {
        if (command.includes('remote get-url')) return 'git@github.com:acme/widgets.git';
        throw new Error('no git');
      },
    };
    expect(() => createLocalOctokit(shell, () => AMBIENT, env, { phase: 'ship' })).toThrow(/repository root/);
  });

  it('prefers explicit repo and settings over probing', () => {
    const octokit = createLocalOctokit(
      shellWith(undefined),
      () => AMBIENT,
      {},
      {
        repo: 'acme/widgets',
        settings: { allowAmbientToken: true },
      },
    );
    expect(credentialSourceOf(octokit)?.source.kind).toBe('ambient');
  });

  it('falls back to default settings when no repo root can be found', () => {
    const shell: LocalShell = {
      execSync: () => {
        throw new Error('no git');
      },
    };
    const octokit = createLocalOctokit(shell, () => AMBIENT, {}, { repo: 'acme/widgets' });
    expect(credentialSourceOf(octokit)?.source).toMatchObject({ kind: 'ambient', ambientReason: 'unconfigured' });
  });

  describe('repo config', () => {
    const tmp = createTempDirs();
    afterEach(async () => {
      await tmp.cleanup();
    });
    const shellAt = (root: string): LocalShell => ({
      execSync: (command) => {
        if (command.includes('show-toplevel')) return `${root}\n`;
        throw new Error('unavailable');
      },
    });
    const repoWithConfig = (config: unknown): string => {
      const root = tmp.makeSync('factory-gh-scope-');
      mkdirSync(join(root, '.factory'), { recursive: true });
      writeFileSync(join(root, '.factory', 'config.json'), JSON.stringify(config));
      return root;
    };

    it('reads github.credentials from the repo config', () => {
      const root = repoWithConfig({ version: 2, github: { credentials: { allowAmbientToken: true } } });
      const octokit = createLocalOctokit(shellAt(root), () => AMBIENT, {}, { repo: 'acme/widgets' });
      expect(credentialSourceOf(octokit)?.source).toMatchObject({ kind: 'ambient', ambientReason: 'opt-in' });
    });

    it('throws when the repo config is invalid instead of dropping it', () => {
      const root = repoWithConfig({ version: 2, github: { credentials: { app: { appId: -1, installationId: 1 } } } });
      expect(() => createLocalOctokit(shellAt(root), () => AMBIENT, {}, { repo: 'acme/widgets' })).toThrow(/Invalid/);
    });
  });
});
