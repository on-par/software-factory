import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import {
  createSimOctokit,
  createSimWorkspace,
  simCommitAll,
  type SimOctokit,
  type SimRecordedCall,
  type SimWorkspace,
} from '../sim/index.js';
import { cleanupWorktree } from '../utils/index.js';
import { withGitLock } from '../utils/lock.js';

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
  return simCommitAll(cwd, message);
}

export type RecordedCall = SimRecordedCall;
export type FakeOctokit = SimOctokit;

export function makeFakeOctokit(
  titles: Record<number, string>,
  bodies: Record<number, string> = {},
): { octokit: FakeOctokit; calls: RecordedCall[] } {
  return createSimOctokit({ titles, bodies });
}

export class PipelineTestKit {
  private cleanupTargets: Array<{ repoRoot: string; worktree: string }> = [];
  private tempDirs = new Set<string>();
  private workspaces: SimWorkspace[] = [];

  async makeThrowawayRepo(): Promise<{ origin: string; repoRoot: string }> {
    const ws = await createSimWorkspace();
    this.workspaces.push(ws);
    return { origin: ws.origin, repoRoot: ws.repoRoot };
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

    await Promise.all(this.workspaces.map((w) => w.dispose()));
    this.workspaces.length = 0;
  }
}
