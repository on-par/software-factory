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
import { withRepoRunLock } from './repo-run-lock.js';
import { shipRuntime } from './ship-runtime.js';
import { shipIssue } from './ship.js';

const CAP_REACHED_EXIT = 1;
const ROUND_FAILED_EXIT = 1;

interface CiReworkEntryRuntime {
  getRepoRoot: () => Promise<string>;
  getGitHubRepo: () => Promise<string>;
  getOctokit: () => Octokit;
  log: (line: string) => void;
}

type CiReworkVerdict =
  | { kind: 'no-change'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'accepted'; reason: string; prNumber: number; used: number };

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

const readRun = (runsDir: string, issueNum: number) =>
  readIssueRunState(runStateFile(runsDir, workKeyFromIssue(issueNum)));

async function decideCiRework(issueNum: number, runsDir: string, rt: CiReworkEntryRuntime): Promise<CiReworkVerdict> {
  const [owner = '', repo = ''] = (await rt.getGitHubRepo()).split('/');
  const octokit = rt.getOctokit();
  const state = await readRun(runsDir, issueNum);
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
    kind: 'accepted',
    prNumber: pr.number,
    used,
    reason: `PR #${pr.number} for #${issueNum} has failing checks (${failing}); starting CI rework round ${used + 1} of ${cap}`,
  };
}

async function runOneRound(
  issueNum: number,
  verdict: Extract<CiReworkVerdict, { kind: 'accepted' }>,
  where: { repoRoot: string; runsDir: string },
  rt: CiReworkEntryRuntime,
): Promise<void> {
  const { prNumber, used } = verdict;
  const ghRepo = await rt.getGitHubRepo();
  let branch: string;
  try {
    branch = await shipIssue(issueNum, {}, { repoRoot: where.repoRoot, ghRepo, ciRework: { prNumber, used } });
  } catch (err) {
    if (err instanceof shipRuntime().IssueSkippedError) return;
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliExitError(
      `factory: CI rework resume of PR #${prNumber} for #${issueNum} failed: ${detail}`,
      ROUND_FAILED_EXIT,
    );
  }
  const after = ciReworkRoundsFor(await readRun(where.runsDir, issueNum), prNumber);
  rt.log(
    after.used > used
      ? `factory: PR #${prNumber} for #${issueNum} ran CI rework round ${after.used} of ${after.cap}, pushed ${branch} and finished SHIP`
      : `factory: PR #${prNumber} for #${issueNum} finished SHIP on ${branch} without a CI rework round`,
  );
}

export async function resumeFromCiRework(issueNum: number, rt: CiReworkEntryRuntime): Promise<void> {
  const repoRoot = await rt.getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const scope = { kind: 'issue' as const, key: workKeyFromIssue(issueNum) };
  await withRepoRunLock(
    paths,
    'factory resume',
    async () => {
      const verdict = await decideCiRework(issueNum, paths.runs, rt);
      if (verdict.kind === 'refused') throw new CliExitError(`factory: ${verdict.reason}`, CAP_REACHED_EXIT);
      rt.log(`factory: ${verdict.reason}`);
      if (verdict.kind === 'accepted') await runOneRound(issueNum, verdict, { repoRoot, runsDir: paths.runs }, rt);
    },
    { scope },
  );
}
