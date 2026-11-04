// packages/core/src/phases/ship-evidence-comment.ts — SHIP evidence-pack PR comment

import { gatherEvidencePack } from '../reports/evidence-pack.js';
import type { CommandRunner } from './ship-git.js';
import type { ShipPhaseOptions } from './ship-options.js';
import type { lazyWalkthrough } from './ship-walkthrough.js';

export async function postEvidenceComment(ctx: {
  opts: ShipPhaseOptions;
  run: CommandRunner;
  owner: string;
  repoName: string;
  prNumber: number;
  walkthrough: ReturnType<typeof lazyWalkthrough>;
}): Promise<void> {
  const { opts, run, owner, repoName, prNumber, walkthrough } = ctx;
  const { issue, octokit, worktree, checkSummary, log } = opts;
  try {
    let checkedSha: string | undefined;
    try {
      checkedSha = (await run('git rev-parse HEAD', { cwd: worktree })).stdout.trim() || undefined;
    } catch {}
    const body = gatherEvidencePack({
      issue,
      checkSummary,
      reworkRounds: opts.reworkRounds,
      specPath: opts.specPath,
      eventsFile: opts.eventsFile,
      startedAt: opts.startedAt,
      logsDir: opts.logsDir,
      reviewRouting: opts.reviewRouting,
      pinNotes: opts.pinNotes,
      headSha: checkedSha,
      walkthrough: await walkthrough.walkthrough(),
    });
    await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body });
    log('evidence', `posted evidence pack to PR #${prNumber}`);
  } catch {}
}
