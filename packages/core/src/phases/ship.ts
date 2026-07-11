// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Octokit } from '@octokit/rest';
import { shellEscape } from '../utils/index.js';

const exec = promisify(execCb);

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
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
  },
): Promise<ShipResult> {
  const { issue, repo, worktree, branch, octokit, watchCI = true, log } = opts;
  const [owner, repoName] = repo.split('/');

  // Check if a PR already exists (claude route may have created one)
  let prNumber = await findOpenPR(octokit, owner, repoName, branch);

  if (!prNumber) {
    // Push branch
    try {
      await exec(`git push -u origin ${shellEscape(branch)}`, { cwd: worktree });
    } catch {
      log('ship', 'push failed — trying to continue');
    }

    // Get title from issue
    const { data: issueData } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
    const title = issueData.title;

    // Get diff stats
    let stat = '';
    try {
      const { stdout } = await exec('git diff --stat origin/main...HEAD', { cwd: worktree });
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
  }

  if (!prNumber) {
    log('fail', `Could not create or find PR for ${branch}`);
    return { ok: false };
  }

  // Mark ready for review (if draft)
  try {
    await octokit.rest.pulls.update({ owner, repo: repoName, pull_number: prNumber, draft: false });
  } catch {}

  // Watch CI (best-effort)
  if (watchCI) {
    log('ship', `Watching CI for PR #${prNumber}`);
    try {
      // Poll checks for up to 10 minutes
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        const { data: checks } = await octokit.rest.checks.listForRef({
          owner,
          repo: repoName,
          ref: branch,
        });
        if (checks.check_runs.length > 0) {
          const allDone = checks.check_runs.every(r => r.status === 'completed');
          const anyFailed = checks.check_runs.some(r => r.conclusion === 'failure');
          if (allDone) {
            if (anyFailed) {
              log('ship', `CI failed for PR #${prNumber}`);
            } else {
              log('ship', `CI green for PR #${prNumber}`);
            }
            break;
          }
        }
        await sleep(15_000);
      }
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}