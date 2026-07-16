import { exec as execCb } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { cleanupWorktree } from '../utils/index.js';
import { withGitLock } from '../utils/lock.js';

const exec = promisify(execCb);

export function makeStubModelsConfig(): ModelsConfig {
  return {
    version: 1,
    models: {
      'stub-model': {
        provider: 'custom',
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
}

export function makeStubRoutesConfig(): RoutesConfig {
  return {
    version: 1,
    routes: {
      plan: { tier: 'boss', description: 'stub' },
      build_claude: { tier: 'boss', description: 'stub' },
    },
  };
}

export function specContentFor(issue: number, title = 'Pipeline integration test'): string {
  return `---
route: claude
---
# Spec: ${title} (#${issue})
## Goal
Exercise the phase pipeline against a throwaway repository.
## Files / approach
Use the scripted stub executor to mutate the worktree.
## Tests
Run the built-in checker sequence.
## Constitution compliance
N/A - no constitution
## Non-goals
No network calls.
`;
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await exec('git add -A', { cwd });
  await exec(`git commit -m '${message}'`, { cwd });
}

export type RecordedCall = [string, ...unknown[]];

export interface FakeOctokit {
  graphql: (query: string, vars: unknown) => Promise<any>;
  rest: {
    issues: { get: (args: any) => Promise<any> };
    pulls: {
      list: (args: any) => Promise<any>;
      create: (args: any) => Promise<any>;
      get: (args: any) => Promise<any>;
    };
    checks: { listForRef: (args: any) => Promise<any> };
  };
}

export function makeFakeOctokit(titles: Record<number, string>): { octokit: FakeOctokit; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let nextPr = 101;

  const octokit: FakeOctokit = {
    graphql: async (query: string, vars: unknown) => {
      calls.push(['graphql', query, vars]);
      return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
    },
    rest: {
      issues: {
        get: async (args: any) => {
          calls.push(['issues.get', args]);
          return { data: { title: titles[args.issue_number], body: 'stub issue body' } };
        },
      },
      pulls: {
        list: async (args: any) => {
          calls.push(['pulls.list', args]);
          return { data: [] };
        },
        create: async (args: any) => {
          calls.push(['pulls.create', args]);
          return { data: { number: nextPr++ } };
        },
        get: async (args: any) => {
          calls.push(['pulls.get', args]);
          return { data: { draft: true, node_id: `PR_${args.pull_number}` } };
        },
      },
      checks: {
        listForRef: async (args: any) => {
          calls.push(['checks.listForRef', args]);
          return { data: { check_runs: [] } };
        },
      },
    },
  };

  return { octokit, calls };
}

export class PipelineTestKit {
  private cleanupTargets: Array<{ repoRoot: string; worktree: string }> = [];
  private tempDirs = new Set<string>();

  async makeThrowawayRepo(): Promise<{ origin: string; repoRoot: string }> {
    const origin = realpathSync(await mkdtemp(join(tmpdir(), 'factory-origin-')));
    const repoRoot = realpathSync(await mkdtemp(join(tmpdir(), 'factory-repo-')));
    this.tempDirs.add(origin);
    this.tempDirs.add(repoRoot);

    await exec('git -c init.defaultBranch=main init --bare', { cwd: origin });
    await exec(`git clone '${origin}' '${repoRoot}'`);
    await exec('git config user.name factory-test', { cwd: repoRoot });
    await exec('git config user.email factory@test', { cwd: repoRoot });
    await exec('git checkout -b main', { cwd: repoRoot });
    await writeFile(join(repoRoot, 'README.md'), '# Throwaway\n');
    await commitAll(repoRoot, 'chore: initial commit');
    await exec('git push -u origin main', { cwd: repoRoot });

    return { origin, repoRoot };
  }

  async makeSpecPath(issue: number): Promise<string> {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'factory-plan-')));
    this.tempDirs.add(root);
    const plans = join(root, 'plans');
    await mkdir(plans, { recursive: true });
    return join(plans, `issue-${issue}.md`);
  }

  trackWorktree(repoRoot: string, issue: number): string {
    const worktree = `${repoRoot}-wt-${issue}`;
    this.cleanupTargets.push({ repoRoot, worktree });
    return worktree;
  }

  async cleanup(): Promise<void> {
    // Lanes sharing one repoRoot must clean up through the same lock that
    // guards worktree mutation, or they race the shared .git/worktrees
    // metadata; the lock is a harmless no-op cost for single-lane suites.
    await Promise.all(
      this.cleanupTargets.map(({ repoRoot, worktree }) =>
        withGitLock(repoRoot, () => cleanupWorktree(repoRoot, worktree)),
      ),
    );
    this.cleanupTargets.length = 0;

    await Promise.all([...this.tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    this.tempDirs.clear();
  }
}
