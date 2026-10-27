// packages/cli/src/cli/land-rebuild.ts — a merge-main conflict at land is rebuilt by the lane on a fresh branch (#3325)

import type { Octokit } from '@octokit/rest';
import type { EventKind, FactoryEvent, RunOutcome } from '@on-par/factory-core';

import { ClaimLostError } from './lane-heartbeat.js';
import { LandConflictError, type LandRebuild } from './land-pr.js';
import { landRuntime } from './land-runtime.js';

const REBUILD_SUFFIX = '-rebuild';

/** The fresh branch a rebuild ships on. The suffix is the durable "already rebuilt once" marker: a branch that
 *  carries it is never rebuilt again, so its next conflict parks. */
export function rebuildBranchFor(branch: string): string {
  return `${branch}${REBUILD_SUFFIX}`;
}

export function isRebuildBranch(branch: string): boolean {
  return branch.endsWith(REBUILD_SUFFIX);
}

export interface ReplacedPr {
  issue: number;
  oldPr: number;
  oldBranch: string;
  newPr: number;
  paths: string[];
}

export function renderReplacedPrComment(r: ReplacedPr): string {
  const paths = r.paths.map((p) => `\`${p}\``).join(', ');
  return [
    `The factory replaced this PR with #${r.newPr}.`,
    '',
    `Merging \`origin/main\` into \`${r.oldBranch}\` conflicted on ${paths}, so #${r.issue} was rebuilt from its frozen spec on a fresh branch off \`main\`. The branch \`${r.oldBranch}\` is kept.`,
  ].join('\n');
}

/** Closes the conflicting PR with a comment that links its replacement. The branch is kept. */
export async function closeReplacedPullRequest(
  ghRepo: string,
  r: ReplacedPr,
  octokit: Pick<Octokit, 'rest'> = landRuntime().getOctokit(),
): Promise<void> {
  const [owner = '', repo = ''] = ghRepo.split('/');
  await octokit.rest.issues.createComment({ owner, repo, issue_number: r.oldPr, body: renderReplacedPrComment(r) });
  await octokit.rest.pulls.update({ owner, repo, pull_number: r.oldPr, state: 'closed' });
}

export interface LandRebuildOps {
  /** The lane's land of `branch`; `rebuildOnConflict` asks land to hand a merge-main conflict back. */
  land: (
    branch: string,
    opts: { syncMain?: boolean; rebuildOnConflict?: boolean; landBranch?: string },
  ) => Promise<void>;
  /** The lane's ship, the only builder, on the fresh `rebuild.branch`. */
  ship: (rebuild: { branch: string }, onOutcome: (o: RunOutcome) => void) => Promise<unknown>;
  closeReplaced: (r: ReplacedPr) => Promise<void>;
  /** Called once the replacement PR is open, with the branch the lane now lands. */
  onRebuilt: (branch: string) => void;
  emit: (kind: EventKind, msg: string, extra?: Pick<FactoryEvent, 'paths'>) => void;
}

/** Lands `branch`. When its merge with origin/main conflicts, rebuilds the issue once on a fresh branch off
 *  origin/main, replaces the PR, and lands the new one. A rebuild that fails parks `conflict`. */
export async function landWithOneRebuild(
  issue: number,
  branch: string,
  syncMain: boolean,
  ops: LandRebuildOps,
): Promise<void> {
  try {
    await ops.land(branch, { syncMain, rebuildOnConflict: !isRebuildBranch(branch) });
  } catch (err) {
    if (!(err instanceof LandConflictError) || !err.rebuild) throw err;
    const rebuilt = await rebuild(issue, err.rebuild, ops);
    ops.onRebuilt(rebuilt);
    await ops.land(rebuilt, { landBranch: rebuilt });
  }
}

async function rebuild(issue: number, conflict: LandRebuild, ops: LandRebuildOps): Promise<string> {
  const { errorDetail } = landRuntime();
  const branch = rebuildBranchFor(conflict.branch);
  const paths = conflict.paths.join(', ');
  ops.emit('land', `PR #${conflict.prNumber} conflicts with origin/main (${paths}); rebuilding #${issue} on ${branch}`);
  const run: { outcome?: RunOutcome } = {};
  const failed = (detail: string): LandConflictError => {
    const stage = run.outcome?.attribution?.endedIn ?? 'setup';
    const msg = `issue #${issue}: rebuild of PR #${conflict.prNumber} failed at ${stage} (conflicting paths: ${paths}): ${detail} — parked`;
    ops.emit('conflict', msg, { paths: conflict.paths });
    return new LandConflictError(msg);
  };
  try {
    await ops.ship({ branch }, (o) => {
      run.outcome = o;
    });
  } catch (err) {
    if (err instanceof ClaimLostError) throw err;
    throw failed(errorDetail(err));
  }
  const { outcome } = run;
  const newPr = outcome?.state === 'ready' || outcome?.state === 'shipped' ? outcome.prNumber : undefined;
  if (newPr === undefined) {
    const ended = outcome
      ? `${outcome.state}${'reason' in outcome ? ` (${outcome.reason})` : ''}`
      : 'without an outcome';
    throw failed(`the run ended ${ended} with no PR`);
  }
  const replaced = { issue, oldPr: conflict.prNumber, oldBranch: conflict.branch, newPr, paths: conflict.paths };
  await ops
    .closeReplaced(replaced)
    .catch((err: unknown) =>
      ops.emit('warn', `could not close PR #${conflict.prNumber} after opening #${newPr}: ${errorDetail(err)}`),
    );
  ops.emit(
    'pr_refresh',
    `PR #${conflict.prNumber} refreshed: mergeStateStatus=${conflict.mergeStateStatus} action=rebuild newPr=#${newPr}`,
  );
  return branch;
}
