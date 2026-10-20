import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirs } from '@on-par/factory-core/testing';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { checkPhase } from '../phases/check.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CheckSummary } from '../types/index.js';
import type { CheckerContext } from './index.js';
import { runVerificationCommand } from './run-command.js';

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { build_claude: { tier: 'boss', description: 'stub' } } };

const tempDirs = createTempDirs();

afterEach(async () => {
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

const PASS: CheckSummary = { results: [], failures: 0, passes: 0, skips: 0, total: 0 };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A worktree plus a host whose global git config sets init.defaultBranch=main. */
async function setup() {
  const host = await tempDirs.make('hermetic-git-host-');
  const globalConfig = join(host, 'gitconfig');
  await writeFile(globalConfig, '[init]\n\tdefaultBranch = main\n');
  vi.stubEnv('HOME', host);
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  const worktree = await tempDirs.make('hermetic-git-wt-');
  git(worktree, 'init', '-b', 'main');
  await mkdir(join(worktree, '.factory'), { recursive: true });
  const specPath = join(worktree, 'issue-3272.md');
  await writeFile(specPath, '# spec\n');
  return { worktree, specPath, host };
}

/** Runs CHECK with an injected checker that runs `argv` under ctx.env and records its stdout. */
async function runUnderCheck(
  hermeticGit: boolean | undefined,
  argv: string[],
  worktree: string,
  specPath: string,
  cwd = worktree,
) {
  const outputs: string[] = [];
  const logs: string[] = [];
  const stub = new StubModelExecutor({ defaultOutput: 'ok' });
  await checkPhase({
    issue: 3272,
    worktree,
    specPath,
    router: new ModelRouter(models, routes, false, stub),
    constitution: null,
    maxReworkRounds: 0,
    hermeticGit,
    log: (type, msg) => {
      if (type === 'check') logs.push(msg);
    },
    runBaseline: async (o) => ({ baseSha: o.baseSha, checkers: [] }),
    runCheckers: async (ctx: CheckerContext) => {
      const res = await runVerificationCommand(argv, { cwd, env: ctx.env });
      outputs.push(res.stdout.trim());
      return PASS;
    },
  });
  return { outputs, logs };
}

describe('hermetic git for checker commands (#3272)', () => {
  it('checker commands do not see the host global git config (#1886, PR #3265)', async () => {
    const { worktree, specPath, host } = await setup();
    const { outputs, logs } = await runUnderCheck(
      undefined,
      ['git', 'config', '--global', '--get', 'init.defaultBranch'],
      worktree,
      specPath,
    );
    expect(outputs).toEqual(['']);
    expect(logs.filter((m) => m.startsWith('hermetic git: on'))).toHaveLength(1);

    // The #1886 fixture: `git init --bare` without -b, then push main and clone.
    const origin = join(host, 'origin.git');
    const src = join(host, 'src');
    const clone = join(host, 'clone');
    const script = [
      `git init --bare ${origin}`,
      `git init -b main ${src}`,
      `git -C ${src} -c user.name=T -c user.email=t@example.com commit --allow-empty -m init`,
      `git -C ${src} push ${origin} main`,
      `git clone ${origin} ${clone}`,
    ].join(' && ');
    await runUnderCheck(undefined, ['sh', '-c', script], worktree, specPath);
    expect((await readdir(clone)).filter((f) => f !== '.git')).toEqual([]);
    const head = git(origin, 'symbolic-ref', 'HEAD').trim();
    expect(head).toBe('refs/heads/master');
  });

  it('hermeticGit false keeps the host global git config visible to checkers', async () => {
    const { worktree, specPath } = await setup();
    const { outputs, logs } = await runUnderCheck(
      false,
      ['git', 'config', '--global', '--get', 'init.defaultBranch'],
      worktree,
      specPath,
    );
    expect(outputs).toEqual(['main']);
    expect(logs.filter((m) => m.startsWith('hermetic git: off'))).toHaveLength(1);
  });

  it('hermetic git still lists repo-local .git/config values', async () => {
    const { worktree, specPath } = await setup();
    git(worktree, 'config', 'user.name', 'Local Tester');
    const { outputs } = await runUnderCheck(undefined, ['git', 'config', '--list'], worktree, specPath);
    expect(outputs[0]).toContain('user.name=Local Tester');
    expect(outputs[0]).not.toContain('init.defaultbranch');
  });
});
