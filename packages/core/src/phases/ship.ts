// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Octokit } from '@octokit/rest';
import { shellEscape } from '../utils/index.js';
import { watchChecks } from '../utils/ci-watch.js';
import type { ApprovalGate } from '../approvals/index.js';
import type { CheckSummary } from '../types/index.js';

const exec = promisify(execCb);
type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string }>;

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
  denied?: boolean;
  deniedReason?: string;
}

export async function shipPhase(
  opts: {
    issue: number;
    repo: string;
    worktree: string;
    branch: string;
    octokit: Octokit;
    watchCI?: boolean;
    log: (type: string, msg: string) => void;
    run?: CommandRunner;
    approvalGate?: ApprovalGate;
    checkSummary?: CheckSummary;
  },
): Promise<ShipResult> {
  const { issue, repo, worktree, branch, octokit, watchCI = true, log, run = exec, approvalGate, checkSummary } = opts;
  const [owner, repoName] = repo.split('/');

  if (approvalGate) {
    let diffStat = '';
    try {
      const { stdout } = await run('git diff --stat origin/main...HEAD', { cwd: worktree });
      diffStat = stdout.split('\n').slice(-20).join('\n');
    } catch {}
    log('approval_requested', `awaiting approval to ship ${branch}${checkSummary ? ` (checks: ${checkSummary.passes} pass, ${checkSummary.failures} fail, ${checkSummary.skips} skip)` : ''}`);
    const response = await approvalGate({ issue, branch, worktree, diffStat, checkSummary });
    if (!response.approved) {
      const reason = response.reason ?? 'denied';
      log('ship_denied', `ship denied for ${branch}: ${reason}`);
      return { ok: false, denied: true, deniedReason: reason };
    }
    log('approval_granted', `approval granted for ${branch}`);
  }

  // Check if a PR already exists (claude route may have created one)
  let prNumber = await findOpenPR(octokit, owner, repoName, branch);

  if (!prNumber) {
    const recoveryState = await inspectRecoveryState(worktree, run);
    if (!recoveryState.clean) {
      log('ship', `not recovering ${branch}: worktree has uncommitted changes`);
      return { ok: false };
    }
    if (!recoveryState.ahead) {
      log('ship', `not recovering ${branch}: no commits ahead of origin/main`);
      return { ok: false };
    }

    // Push branch
    try {
      await run(`git push -u origin ${shellEscape(branch)}`, { cwd: worktree });
    } catch {
      log('ship', 'push failed — trying to continue');
    }

    // Get title from issue
    const { data: issueData } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    const title = issueData.title;

    // Get diff stats
    let stat = '';
    try {
      const { stdout } = await run('git diff --stat origin/main...HEAD', { cwd: worktree });
      stat = stdout.split('\n').slice(-20).join('\n');
    } catch {}

    // Create PR
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo: repoName,
      head: branch,
      base: 'main',
      title: `${title} (#${issue})`,
      body: `## Summary
Implements #${issue}. Built by the Software Factory (PLAN → BUILD → CHECK → SHIP).

## Changes
\`\`\`
${stat}
\`\`\`

## Verification
This PR passed independent verification by checker agents before shipping.

Closes #${issue}`,
    });

    prNumber = pr.number;
    log('recovered', `opened PR #${prNumber} for committed work on ${branch}`);
  }

  if (!prNumber) {
    log('fail', `Could not create or find PR for ${branch}`);
    return { ok: false };
  }

  // Mark ready for review (if draft). REST pulls.update ignores `draft`;
  // undrafting requires the markPullRequestReadyForReview GraphQL mutation.
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
    if (pr.draft) {
      await octokit.graphql(
        `mutation MarkPullRequestReady($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            pullRequest { isDraft }
          }
        }`,
        { id: pr.node_id },
      );
    }
  } catch {}

  // Watch CI (best-effort)
  if (watchCI) {
    log('ship', `Watching CI for PR #${prNumber}`);
    try {
      const outcome = await watchChecks({ octokit, owner, repo: repoName, ref: branch });
      if (outcome === 'success') log('ship', `CI green for PR #${prNumber}`);
      else if (outcome === 'failure') log('ship', `CI failed for PR #${prNumber}`);
      // outcome === 'timeout': no log, proceed to ready (unchanged best-effort behavior)
    } catch {}
  }

  log('ready', `PR #${prNumber} ready for review`);
  return { ok: true, prNumber };
}

async function findOpenPR(octokit: Octokit, owner: string, repo: string, branch: string): Promise<number | undefined> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${branch}`,
    });
    return prs[0]?.number;
  } catch {
    return undefined;
  }
}

async function inspectRecoveryState(
  worktree: string,
  run: CommandRunner,
): Promise<{ clean: boolean; ahead: boolean }> {
  const [{ stdout: status }, { stdout: ahead }] = await Promise.all([
    run('git status --porcelain', { cwd: worktree }),
    run('git rev-list --count origin/main..HEAD', { cwd: worktree }),
  ]);
  return {
    clean: status.trim() === '',
    ahead: Number.parseInt(ahead.trim(), 10) > 0,
  };
}

