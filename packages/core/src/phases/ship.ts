// src/phases/ship.ts — SHIP phase: create/verify PR, mark ready for review

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';
import { formatAdrNumber } from '@on-par/adr-kit';
import { createFsReader } from '@on-par/repo-context';

import { applyAdrWritePlan, planAdrWrites, readAdrDrafts } from '../adr/write.js';
import type { ApprovalGate } from '../approvals/index.js';
import type { EventKind } from '../events/kinds.js';
import { gatherEvidencePack } from '../reports/evidence-pack.js';
import type { CheckSummary } from '../types/index.js';
import { watchChecks } from '../utils/ci-watch.js';
import { shellEscape } from '../utils/index.js';
import { GITHUB_ISSUE_SOURCE } from '../work/github-issue.js';
import type { WorkRequest } from '../work/index.js';

const exec = promisify(execCb);
type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string }>;

export interface ShipResult {
  ok: boolean;
  prNumber?: number;
  denied?: boolean;
  deniedReason?: string;
  /** True when the branch's content had already landed on main (e.g. a retry after a
   *  squash merge) — nothing was pushed and no PR was created (#520). */
  alreadyDelivered?: boolean;
}

export async function shipPhase(opts: {
  issue: number;
  repo: string;
  worktree: string;
  branch: string;
  octokit: Octokit;
  watchCI?: boolean;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  approvalGate?: ApprovalGate;
  checkSummary?: CheckSummary;
  specPath?: string;
  eventsFile?: string;
  startedAt?: string;
  logsDir?: string;
  reworkRounds?: number;
  today?: string;
  /** The run's resolved work request; when its kind is not 'github-issue', the PR
   *  title/body come from it instead of fetching the (nonexistent) issue (#507). */
  work?: Pick<WorkRequest, 'id' | 'kind' | 'title'>;
}): Promise<ShipResult> {
  const { issue, repo, worktree, branch, octokit, watchCI = true, log, run = exec, approvalGate, checkSummary } = opts;
  const [owner, repoName] = repo.split('/');

  const adr = await materializeAdrDrafts({
    issue,
    repo,
    worktree,
    specPath: opts.specPath,
    run,
    log,
    today: opts.today ?? new Date().toISOString().slice(0, 10),
  });

  let diffStat: string | undefined;

  if (approvalGate) {
    // Log a 'ship'-typed event before anything else so the TUI's activePhase
    // advances to SHIP first — otherwise a denial reports failedPhase as
    // whichever phase (CHECK/BUILD) last logged, which is misleading.
    log('ship', `Starting ship phase for ${branch}`);
    diffStat = await computeDiffStat(run, worktree);
    log(
      'approval_requested',
      `awaiting approval to ship ${branch}${checkSummary ? ` (checks: ${checkSummary.passes} pass, ${checkSummary.failures} fail, ${checkSummary.skips} skip)` : ''}`,
    );
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

  if (prNumber && adr.committed) {
    try {
      await run(`git push origin ${shellEscape(branch)}`, { cwd: worktree });
    } catch {
      log('ship', 'pushing the ADR commit failed — the open PR may not include it');
    }
  }

  if (!prNumber) {
    // Recovery decisions must compare against the *current* remote — a stale
    // remote-tracking ref makes already-delivered work look like recovery work (#520).
    try {
      await run('git fetch origin main', { cwd: worktree });
    } catch {
      log('ship', 'git fetch origin main failed — recovery may compare against a stale origin/main');
    }

    // A failed ADR commit leaves its files on disk uncommitted (see materializeAdrDrafts) —
    // never let that alone make the worktree look dirty and abort the whole ship.
    const recoveryState = await inspectRecoveryState(worktree, run, adr.committed ? [] : adr.paths);
    if (!recoveryState.clean) {
      log('ship', `not recovering ${branch}: worktree has uncommitted changes`);
      return { ok: false };
    }
    if (recoveryState.landed || !recoveryState.ahead) {
      // The branch's content is already on main: identical trees (squash merge) or an
      // empty ahead-count (merge commit / fast-forward). That is delivery, not recovery.
      const mergedPr = await findMergedPR(octokit, owner, repoName, branch);
      if (mergedPr !== undefined || recoveryState.landed) {
        log(
          'ship',
          `not recovering ${branch}: already delivered${mergedPr !== undefined ? ` by merged PR #${mergedPr}` : ' (HEAD tree matches origin/main)'}`,
        );
        return { ok: true, prNumber: mergedPr, alreadyDelivered: true };
      }
      log('ship', `not recovering ${branch}: no commits ahead of origin/main`);
      return { ok: false };
    }

    // Push branch
    try {
      await run(`git push -u origin ${shellEscape(branch)}`, { cwd: worktree });
    } catch {
      log('ship', 'push failed — trying to continue');
    }

    const inlineWork = opts.work && opts.work.kind !== GITHUB_ISSUE_SOURCE ? opts.work : undefined;

    // Get title from issue (skipped for a non-github work source — no such issue exists)
    const title = inlineWork
      ? inlineWork.title
      : (await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue })).data.title;

    // Get diff stats (reuse the approval gate's diff stat when already computed)
    const stat = diffStat ?? (await computeDiffStat(run, worktree));

    const summaryLine = inlineWork
      ? `Implements local brief \`${inlineWork.id}\`. Built by the Software Factory (PLAN → BUILD → CHECK → SHIP).`
      : `Implements #${issue}. Built by the Software Factory (PLAN → BUILD → CHECK → SHIP).`;

    // Create PR
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo: repoName,
      head: branch,
      base: 'main',
      title: inlineWork ? title : `${title} (#${issue})`,
      body: `## Summary
${summaryLine}

## Changes
\`\`\`
${stat}
\`\`\`

## Verification
This PR passed independent verification by checker agents before shipping.${inlineWork ? '' : `\n\nCloses #${issue}`}`,
    });

    prNumber = pr.number;
    log('recovered', `opened PR #${prNumber} for committed work on ${branch}`);
  }

  if (!prNumber) {
    log('fail', `Could not create or find PR for ${branch}`);
    return { ok: false };
  }

  try {
    const body = gatherEvidencePack({
      issue,
      checkSummary,
      reworkRounds: opts.reworkRounds,
      specPath: opts.specPath,
      eventsFile: opts.eventsFile,
      startedAt: opts.startedAt,
      logsDir: opts.logsDir,
    });
    await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body });
    log('evidence', `posted evidence pack to PR #${prNumber}`);
  } catch {}

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

async function computeDiffStat(run: CommandRunner, worktree: string): Promise<string> {
  try {
    const { stdout } = await run('git diff --stat origin/main...HEAD', { cwd: worktree });
    return stdout.split('\n').slice(-20).join('\n');
  } catch {
    return '';
  }
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

async function findMergedPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<number | undefined> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      head: `${owner}:${branch}`,
    });
    return prs.find((pr) => pr.merged_at != null)?.number;
  } catch {
    return undefined;
  }
}

async function inspectRecoveryState(
  worktree: string,
  run: CommandRunner,
  ignorePaths: string[] = [],
): Promise<{ clean: boolean; ahead: boolean; landed: boolean }> {
  const statusCommand =
    ignorePaths.length > 0
      ? `git status --porcelain -- . ${ignorePaths.map((p) => shellEscape(`:!${p}`)).join(' ')}`
      : 'git status --porcelain';
  const [{ stdout: status }, { stdout: ahead }, landed] = await Promise.all([
    run(statusCommand, { cwd: worktree }),
    run('git rev-list --count origin/main..HEAD', { cwd: worktree }),
    // A squash merge leaves origin/main..HEAD nonzero forever even though the branch's
    // tree is byte-identical to main — exit 0 here is the reliable "already landed" signal.
    run('git diff --quiet origin/main..HEAD', { cwd: worktree }).then(
      () => true,
      () => false,
    ),
  ]);
  return {
    clean: status.trim() === '',
    ahead: Number.parseInt(ahead.trim(), 10) > 0,
    landed,
  };
}

/** The written path's own filename already carries the repo's detected number padding
 *  (e.g. '002-x.md' in a 3-digit-convention repo) — reuse it so the commit message and log
 *  never disagree with the file actually on disk, unlike formatAdrNumber's default width-4. */
function adrNumberLabel(write: { path: string; number: number }): string {
  const match = /^(\d+)-/.exec(write.path.split('/').pop() ?? '');
  return match ? match[1] : formatAdrNumber(write.number);
}

async function materializeAdrDrafts(o: {
  issue: number;
  repo: string;
  worktree: string;
  specPath?: string;
  run: CommandRunner;
  log: (type: EventKind, msg: string) => void;
  today: string;
}): Promise<{ committed: boolean; paths: string[] }> {
  if (!o.specPath) return { committed: false, paths: [] };
  const drafts = await readAdrDrafts(o.specPath);
  if (drafts.length === 0) return { committed: false, paths: [] };

  // A 'ship'-typed line first, for the same reason the approval block logs one: it is what
  // advances the TUI's activePhase to SHIP.
  o.log('ship', `materializing ${drafts.length} ADR draft(s) from the frozen plan`);

  const reader = createFsReader({
    root: o.worktree,
    onDegrade: (event) => {
      if (event.reason === 'not-found') return; // a repo with no docs/adr is normal
      o.log('adr_read_degraded', `adr read degraded: ${event.operation} ${event.path} (${event.reason})`);
    },
  });
  const plan = await planAdrWrites(reader, drafts, {
    date: o.today,
    issueRef: { text: `Issue #${o.issue}`, url: `https://github.com/${o.repo}/issues/${o.issue}` },
  });
  for (const r of plan.rejected) {
    o.log('adr_draft_rejected', `ADR draft "${r.title}" refused: ${r.errors.join('; ')}`);
  }
  for (const s of plan.skipped) {
    o.log('adr_draft_skipped', `ADR draft "${s.title}" skipped (${s.reason})`);
  }
  if (plan.indexSkipped) {
    o.log('adr_index_skipped', `ADR index not updated in ${plan.dir} (${plan.indexSkipped})`);
  }
  if (plan.writes.length === 0) return { committed: false, paths: [] };

  const written = await applyAdrWritePlan(plan, { root: o.worktree });
  const labels = plan.writes.map((w) => `ADR-${adrNumberLabel(w)} ${w.title}`).join(', ');
  try {
    await o.run(`git add ${written.map(shellEscape).join(' ')}`, { cwd: o.worktree });
    await o.run(`git commit -m ${shellEscape(`docs(adr): record ${labels} (#${o.issue})`)}`, { cwd: o.worktree });
  } catch {
    // Nothing staged (an identical re-ship) or git refused — the files are on disk either
    // way; never fail a ship over documentation. The caller excludes `paths` from its own
    // dirty-worktree check so this alone never aborts the rest of shipPhase.
    o.log('adr_commit_skipped', `could not commit ${plan.dir} — the ADR may not reach the PR`);
    return { committed: false, paths: written };
  }
  o.log('adr_written', `recorded ${plan.writes.length} ADR(s) in ${plan.dir}: ${labels}`);
  return { committed: true, paths: written };
}
