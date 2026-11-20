import type { Octokit } from '@octokit/rest';
import { getFactoryPaths, workKeyFromIssue } from '@on-par/factory-core';
import {
  ciReworkRoundsFor,
  classifyHeadChecks,
  fetchRequiredContexts,
  listAllCheckRuns,
  readIssueRunState,
  runStateFile,
} from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';
import { findOpenPRForIssue } from './land-find-pr.js';

const CAP_REACHED_EXIT = 1;
const WOULD_REWORK_EXIT = 3;

interface CiReworkEntryRuntime {
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  log: (line: string) => void;
}

type CiReworkVerdict =
  | { kind: 'no-change'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'would-rework'; reason: string };

export function resumePhase(from: string | undefined): 'check' | 'ci-rework' {
  if (from === 'check' || from === 'ci-rework') return from;
  throw new CliExitError(
    'factory: resume <issue> only supports --from check or --from ci-rework (BUILD resume is #2320)',
    2,
  );
}

async function headChecks(octokit: Octokit, owner: string, repo: string, prNumber: number) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const required = await fetchRequiredContexts(octokit, { owner, repo, branch: data.base.ref });
  const all = await listAllCheckRuns(octokit, owner, repo, data.head.sha, 100, 10);
  const runs = all.map((r) => ({ name: r.name ?? '', status: r.status ?? null, conclusion: r.conclusion ?? null }));
  return classifyHeadChecks(required, runs);
}

async function decideCiRework(issueNum: number, rt: CiReworkEntryRuntime): Promise<CiReworkVerdict> {
  const runsDir = getFactoryPaths(await rt.getRepoRoot()).runs;
  const [owner = '', repo = ''] = (await rt.getGitHubRepo()).split('/');
  const octokit = rt.getOctokit();
  const state = await readIssueRunState(runStateFile(runsDir, workKeyFromIssue(issueNum)));
  const pr = await findOpenPRForIssue(octokit, owner, repo, issueNum);
  if (!pr) {
    const last = state?.prNumber === undefined ? '' : ` (PR #${state.prNumber} is closed or merged)`;
    return { kind: 'no-change', reason: `#${issueNum} has no open PR${last}; nothing to rework` };
  }
  const checks = await headChecks(octokit, owner, repo, pr.number);
  if (checks.state === 'green') {
    return { kind: 'no-change', reason: `PR #${pr.number} for #${issueNum} is green; nothing to rework` };
  }
  if (checks.state !== 'failed') {
    return {
      kind: 'no-change',
      reason: `PR #${pr.number} for #${issueNum} has no failing checks yet; nothing to rework`,
    };
  }
  const { used, cap } = ciReworkRoundsFor(state, pr.number);
  const failing = checks.failed.join(', ');
  if (used >= cap) {
    return {
      kind: 'refused',
      reason: `PR #${pr.number} for #${issueNum} already used ${used} of ${cap} CI rework rounds; refusing another round (failing: ${failing})`,
    };
  }
  return {
    kind: 'would-rework',
    reason: `PR #${pr.number} for #${issueNum} would rework: round ${used + 1} of ${cap} (failing: ${failing}); no round started`,
  };
}

export async function resumeFromCiRework(issueNum: number, rt: CiReworkEntryRuntime): Promise<void> {
  const verdict = await decideCiRework(issueNum, rt);
  if (verdict.kind === 'refused') throw new CliExitError(`factory: ${verdict.reason}`, CAP_REACHED_EXIT);
  rt.log(`factory: ${verdict.reason}`);
  if (verdict.kind === 'would-rework') process.exitCode = WOULD_REWORK_EXIT;
}
