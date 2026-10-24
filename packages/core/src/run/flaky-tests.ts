// packages/core/src/run/flaky-tests.ts — files or updates flaky-test issues for tests that flaked in a run.
import type { Octokit } from '@octokit/rest';

import { recordFlakes, setFlakyIssue, type FlakyThresholdEntry } from '../checkers/flaky-ledger.js';
import type { CheckPhaseResult } from '../phases/check.js';
import type { RunPorts, RunRequest } from './run-issue.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseRunKey(run: string): string {
  const [issue, sha] = run.split('@');
  return sha === undefined ? run : `#${issue} on base ${sha}`;
}

function renderFlakyIssueBody(entry: FlakyThresholdEntry, baseSha: string, logPath?: string): string {
  return [
    `The test \`${entry.test}\` failed on its first attempt and passed on a serial re-run (a flake).`,
    '',
    `It has flaked in ${entry.runs.length} distinct runs:`,
    ...entry.runs.map((run) => `- ${parseRunKey(run)}`),
    '',
    `Latest base SHA: ${baseSha}`,
    ...(logPath !== undefined ? [`Re-run log: ${logPath}`] : []),
  ].join('\n');
}

function renderFlakyComment(entry: FlakyThresholdEntry, run: string, baseSha: string, logPath?: string): string {
  return [
    `\`${entry.test}\` flaked again in ${parseRunKey(run)} (base ${baseSha}).`,
    `It has now flaked in ${entry.runs.length} distinct runs.`,
    ...(logPath !== undefined ? [`Re-run log: ${logPath}`] : []),
  ].join('\n');
}

/** Records passing-flake tests in the ledger and files or updates a flaky-test issue for those at
 *  the threshold. Never throws: every ledger or GitHub failure is logged. */
export async function fileFlakyTests(args: {
  request: Pick<RunRequest, 'issue' | 'repo' | 'localOnly' | 'noPr'>;
  octokit: Octokit;
  log: ReturnType<RunPorts['events']>;
  file: string;
  baseSha: string;
  tests: string[];
  logPath?: string;
}): Promise<void> {
  const { request, octokit, log, file, baseSha, tests, logPath } = args;
  const run = `${request.issue}@${baseSha.slice(0, 8)}`;
  let hits: FlakyThresholdEntry[];
  try {
    hits = await recordFlakes(file, run, tests);
  } catch (err) {
    log('environment_warning', `could not update the flaky-test ledger: ${errorMessage(err)}`);
    return;
  }
  for (const hit of hits) {
    if (request.localOnly || request.noPr) {
      const mode = request.noPr ? '--no-pr' : 'local-only';
      log('flaky_tests', `flaky test ${hit.test} reached ${hit.runs.length} runs — ${mode} run, not filing`);
      continue;
    }
    const [owner, repoName] = request.repo.split('/');
    try {
      if (hit.issue === null) {
        const { data } = await octokit.rest.issues.create({
          owner,
          repo: repoName,
          title: `flaky: ${hit.test}`,
          labels: ['bug', 'testing'],
          body: renderFlakyIssueBody(hit, baseSha, logPath),
        });
        await setFlakyIssue(file, hit.test, data.number);
        log('flaky_tests', `filed #${data.number} for flaky test ${hit.test} (${hit.runs.length} runs)`);
      } else {
        await octokit.rest.issues.createComment({
          owner,
          repo: repoName,
          issue_number: hit.issue,
          body: renderFlakyComment(hit, run, baseSha, logPath),
        });
        log('flaky_tests', `commented on #${hit.issue} for flaky test ${hit.test} (${hit.runs.length} runs)`);
      }
    } catch (err) {
      log('environment_warning', `could not file the flaky-test issue for ${hit.test}: ${errorMessage(err)}`);
    }
  }
}

/** Logs CHECK's serial flake re-run verdict and files the tests that passed on re-run (#2303). */
export async function reportFlakeRerun(
  check: CheckPhaseResult,
  request: Pick<RunRequest, 'issue' | 'repo' | 'localOnly' | 'noPr' | 'flakyLedgerPath'>,
  octokit: Octokit,
  log: ReturnType<RunPorts['events']>,
): Promise<void> {
  const flake = check.flakeRerun;
  if (!flake || flake.verdict === 'not-run' || !check.baseline) return;
  log(
    'flaky_tests',
    `tests re-run ${flake.verdict} on base ${check.baseline.baseSha.slice(0, 8)} (${flake.mode}${flake.tests.length > 0 ? `: ${flake.tests.join(', ')}` : ''})`,
    {
      flakyTests: {
        sha: check.baseline.baseSha,
        checker: 'tests',
        mode: flake.mode,
        tests: flake.tests,
        verdict: flake.verdict,
        ...(flake.logPath !== undefined ? { logPath: flake.logPath } : {}),
      },
    },
  );
  if (flake.verdict === 'passed' && flake.tests.length > 0 && request.flakyLedgerPath !== undefined) {
    await fileFlakyTests({
      request,
      octokit,
      log,
      file: request.flakyLedgerPath,
      baseSha: check.baseline.baseSha,
      tests: flake.tests,
      logPath: flake.logPath,
    });
  }
}
