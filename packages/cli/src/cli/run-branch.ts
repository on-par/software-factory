import type { Octokit } from '@octokit/rest';
import {
  GITHUB_ISSUE_SOURCE,
  type LocalOnlyPolicy,
  type SizeGateMode,
  type WorkRequest,
  workKeyFromIssue,
} from '@on-par/factory-core';
import { branchFor, findAdoptablePr, logEvent, type CheckResumeRecord } from '@on-par/factory-core/internal';
import { findSliceIndex } from './ship-steps.js';
import { shipRuntime } from './ship-runtime.js';

/**
 * Picks the lane branch. A plain GitHub-issue claim first looks for the issue's open factory PR so a requeue
 * continues on the stranded draft even after a title or prefix change (#2253); several candidates park as
 * escalate before any worktree exists. resume, rebuild, local-only and slice runs keep their branch selection; explicit stack runs
 * keep theirs too, while a defaulted or aliased stack still adopts (#3832).
 */
export async function resolveRunBranch(opts: {
  issueNum: number;
  issueTitle: string;
  ghRepo: string;
  branchPrefix?: string;
  sizeGateMode: SizeGateMode;
  /** #3832: stack came from --stack, --size-gate stack or sizeGate.mode: stack. */
  explicitStack?: boolean;
  parkOverBudget?: boolean;
  work: WorkRequest;
  ctx?: { localOnly?: LocalOnlyPolicy; resumeFrom?: CheckResumeRecord; lane?: string; rebuild?: { branch: string } };
  /** --no-pr: always a fresh branch, never an adopted open PR's. */
  noPr?: boolean;
  /** --base-branch (#3764): a run started from another ref never adopts an open PR. */
  baseBranch?: string;
  octokit: Octokit;
  eventsFile: string;
}): Promise<string> {
  const {
    issueNum,
    issueTitle,
    ghRepo,
    branchPrefix,
    sizeGateMode,
    explicitStack,
    work,
    ctx,
    noPr,
    baseBranch,
    octokit,
    eventsFile,
  } = opts;
  if (ctx?.rebuild) return ctx.rebuild.branch; // #3325: never adopt the conflicting PR being replaced
  const sliceIndex = opts.parkOverBudget
    ? undefined
    : await findSliceIndex({ sizeGateMode, ctx, work, octokit, ghRepo, issueNum });
  if (ctx?.resumeFrom) return ctx.resumeFrom.branch;
  const fresh = branchFor(workKeyFromIssue(issueNum), issueTitle, branchPrefix, sliceIndex);
  if (
    ctx?.localOnly ||
    noPr ||
    baseBranch !== undefined ||
    sliceIndex !== undefined ||
    (sizeGateMode === 'stack' && explicitStack === true) ||
    work.kind !== GITHUB_ISSUE_SOURCE
  ) {
    return fresh;
  }
  const found = await findAdoptablePr({ octokit, repo: ghRepo, issue: workKeyFromIssue(issueNum), branchPrefix });
  const log = (kind: 'pr-adopted' | 'pr-adopt-ambiguous' | 'pr-adopt-lookup-failed', msg: string): void =>
    logEvent(eventsFile, kind, issueNum, msg, { lane: ctx?.lane });
  switch (found.status) {
    case 'found':
      log(
        'pr-adopted',
        `adopting open PR #${found.prNumber} on ${found.branch} @ ${found.headSha} — prior CI evidence is on that PR; requeue continues on its head (#2253)`,
      );
      return found.branch;
    case 'ambiguous': {
      const list = found.prs.map((p) => `#${p.prNumber} (${p.branch})`).join(', ');
      const msg = `${found.prs.length} open factory PRs match #${issueNum}: ${list} — close or relabel all but one, then requeue`;
      log('pr-adopt-ambiguous', msg);
      throw new (shipRuntime().LaneParkError)(`ambiguous open PRs for #${issueNum}: ${msg}`, 'escalate');
    }
    case 'error':
      log('pr-adopt-lookup-failed', `open PR lookup for #${issueNum} failed: ${found.detail} — using ${fresh}`);
      return fresh;
    case 'absent':
      return fresh;
  }
}
