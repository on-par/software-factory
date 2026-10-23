import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { execGit } from '../utils/git-exec.js';
import type { CheckSummary } from '../types/index.js';
import { checkPhase } from './check.js';
import { shipPhase } from './ship.js';

const execFile = promisify(execFileCallback);
const tempDirs = createTempDirs();
afterEach(async () => tempDirs.cleanup());

const passingSummary: CheckSummary = {
  failures: 0,
  passes: 1,
  skips: 0,
  total: 1,
  results: [{ checker: 'compile', result: 'PASS', details: 'ok' }],
};

const models: ModelsConfig = {
  version: 1,
  models: {
    stub: {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub'] },
  failover: { triggers: ['error'], maxRetries: 0, cooldownMs: 0 },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: {} };

async function makeRepo(): Promise<{ worktree: string; specPath: string }> {
  const worktree = await tempDirs.make('ship-intent-to-add-');
  const remote = await tempDirs.make('ship-intent-to-add-origin-');
  await mkdir(join(worktree, 'packages/x/src'), { recursive: true });
  await execGit(['init', '-q', '-b', 'main'], { cwd: worktree });
  await execGit(['config', 'user.name', 'Factory Test'], { cwd: worktree });
  await execGit(['config', 'user.email', 'factory-test@example.invalid'], { cwd: worktree });
  await writeFile(join(worktree, 'packages/x/src/edit.ts'), 'before\n');
  await writeFile(join(worktree, 'packages/x/src/remove.ts'), 'remove me\n');
  const specPath = join(worktree, 'issue.md');
  await writeFile(specPath, '# Test issue\n');
  await execGit(['add', '-A'], { cwd: worktree });
  await execGit(['commit', '-qm', 'initial'], { cwd: worktree });
  await execGit(['init', '--bare', '-q', remote]);
  await execGit(['remote', 'add', 'origin', remote], { cwd: worktree });
  await execGit(['push', '-q', '-u', 'origin', 'main'], { cwd: worktree });
  await execGit(['checkout', '-qb', 'ship-it/3271'], { cwd: worktree });
  return { worktree, specPath };
}

async function runGit(command: string, cwd: string): Promise<{ stdout: string }> {
  const argsByCommand: Array<[RegExp, (match: RegExpExecArray) => string[]]> = [
    [/^git fetch origin main$/, () => ['fetch', 'origin', 'main']],
    [/^git status --porcelain$/, () => ['status', '--porcelain']],
    [/^git rev-list --count origin\/main\.\.HEAD$/, () => ['rev-list', '--count', 'origin/main..HEAD']],
    [/^git diff --quiet origin\/main\.\.HEAD$/, () => ['diff', '--quiet', 'origin/main..HEAD']],
    [/^git add -A$/, () => ['add', '-A']],
    [/^git diff --cached --quiet$/, () => ['diff', '--cached', '--quiet']],
    [/^git commit -m '(.+)'$/, (match) => ['commit', '-m', match[1]!]],
    [/^git push -u origin '?(.*?)'?$/, (match) => ['push', '-u', 'origin', match[1]!]],
    [/^git rev-parse HEAD$/, () => ['rev-parse', 'HEAD']],
    [/^git ls-remote --heads origin '?(.*?)'?$/, (match) => ['ls-remote', '--heads', 'origin', match[1]!]],
    [/^git diff --stat origin\/main\.\.\.HEAD$/, () => ['diff', '--stat', 'origin/main...HEAD']],
  ];
  for (const [pattern, args] of argsByCommand) {
    const match = pattern.exec(command);
    if (match) {
      const result = await execFile('git', args(match), { cwd });
      return { stdout: result.stdout };
    }
  }
  throw new Error(`unexpected local git command: ${command}`);
}

function octokitForPr(calls: string[]) {
  return {
    graphql: async () => ({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }),
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          calls.push('create');
          return { data: { number: 3271 } };
        },
        get: async () => ({ data: { draft: true, node_id: 'PR_3271' } }),
      },
      issues: {
        get: async () => ({ data: { title: 'Check intent-to-add' } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    },
  };
}

describe('SHIP after CHECK intent-to-add', () => {
  it('SHIP commits the exact tree enumerated during CHECK from an intent-to-add index', async () => {
    const { worktree, specPath } = await makeRepo();
    await writeFile(join(worktree, 'packages/x/src/new.ts'), 'new content\n');
    await writeFile(join(worktree, 'packages/x/src/edit.ts'), 'edited content\n');
    await unlink(join(worktree, 'packages/x/src/remove.ts'));

    let checkedPaths: string[] = [];
    const router = new ModelRouter(models, routes, false, new StubModelExecutor({ defaultOutput: 'ok' }));
    const check = await checkPhase({
      issue: 3271,
      worktree,
      specPath,
      router,
      constitution: null,
      log: () => {},
      runCheckers: async (ctx) => {
        const output = (await execGit(['ls-files', '-z'], { cwd: ctx.worktree })).stdout;
        checkedPaths = output
          .split('\0')
          .filter((path) => path !== '')
          .sort();
        expect(checkedPaths).toContain('packages/x/src/new.ts');
        expect(checkedPaths).not.toContain('packages/x/src/remove.ts');
        return passingSummary;
      },
    });
    expect(check.passed).toBe(true);

    const openedPrs: string[] = [];
    const shipped = await shipPhase({
      issue: 3271,
      repo: 'on-par/software-factory',
      worktree,
      branch: 'ship-it/3271',
      octokit: octokitForPr(openedPrs) as any,
      watchCI: false,
      checkSummary: passingSummary,
      log: () => {},
      run: (command, options) => runGit(command, options?.cwd ?? worktree),
    });

    const committed = (await execGit(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { cwd: worktree })).stdout
      .split('\0')
      .filter((path) => path !== '')
      .sort();
    expect(committed).toEqual(checkedPaths);
    expect(await readFile(join(worktree, 'packages/x/src/new.ts'), 'utf8')).toBe('new content\n');
    expect(await readFile(join(worktree, 'packages/x/src/edit.ts'), 'utf8')).toBe('edited content\n');
    expect(committed).not.toContain('packages/x/src/remove.ts');
    expect((await execGit(['status', '--porcelain'], { cwd: worktree })).stdout).toBe('');
    expect((await execGit(['rev-list', '--count', 'origin/main..HEAD'], { cwd: worktree })).stdout.trim()).toBe('1');
    expect(shipped).toMatchObject({ ok: true, prNumber: 3271 });
    expect(openedPrs).toEqual(['create']);
  });
});
