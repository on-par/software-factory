// packages/core/src/utils/ci-evidence.ts — bounded, read-only evidence for a SHIP CI-watch failure (#2814)

import type { Octokit } from '@octokit/rest';

import type { CiCodeScanningAlert, CiFailingCheck, CiFailureEvidence, CiJobLogExcerpt } from '../types/index.js';

import { isPassingConclusion, listAllCheckRuns } from './ci-watch.js';

export const CI_EVIDENCE_LIMITS = {
  maxChecks: 10,
  maxAlerts: 10,
  maxSummaryChars: 500,
  maxMessageChars: 300,
  maxJobLogs: 3,
  maxLogLines: 150,
  maxLogChars: 16000,
} as const;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Re-list the branch's check runs after the CI watch ended 'failure' and summarise the ones that did
 * not pass. When a failing check is CodeQL, also list the open code-scanning alerts on the PR's merge ref:
 * CodeQL on pull_request analyzes refs/pull/<n>/merge, so refs/pull/<n>/head returns no alerts.
 * Best-effort and GET-only: it never throws and never changes the park reason.
 */
export async function collectCiFailureEvidence(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  prNumber: number;
}): Promise<CiFailureEvidence> {
  const { octokit, owner, repo, ref, prNumber } = opts;
  const errors: string[] = [];
  let truncated = false;
  const clip = (text: string, max: number): string => {
    if (text.length <= max) return text;
    truncated = true;
    return `${text.slice(0, max - 1)}…`;
  };

  let failingChecks: CiFailingCheck[] = [];
  try {
    const runs = await listAllCheckRuns(octokit, owner, repo, ref, 100, 10);
    const failing = runs.filter((r) => r.status === 'completed' && !isPassingConclusion(r.conclusion));
    if (failing.length > CI_EVIDENCE_LIMITS.maxChecks) truncated = true;
    failingChecks = failing.slice(0, CI_EVIDENCE_LIMITS.maxChecks).map((r) => {
      const text = r.output?.summary || r.output?.title || '';
      return {
        name: r.name ?? '(unnamed)',
        conclusion: r.conclusion ?? 'null',
        ...(text ? { summary: clip(text, CI_EVIDENCE_LIMITS.maxSummaryChars) } : {}),
      };
    });
  } catch (err) {
    errors.push(`checks: ${errorMessage(err)}`);
  }

  let alerts: CiCodeScanningAlert[] = [];
  if (failingChecks.some((c) => /codeql/i.test(c.name))) {
    try {
      const { data } = await octokit.rest.codeScanning.listAlertsForRepo({
        owner,
        repo,
        ref: `refs/pull/${prNumber}/merge`,
        state: 'open',
        per_page: 100,
      });
      if (data.length > CI_EVIDENCE_LIMITS.maxAlerts) truncated = true;
      alerts = data.slice(0, CI_EVIDENCE_LIMITS.maxAlerts).map((a) => {
        const loc = a.most_recent_instance?.location;
        const location = loc?.path ? loc.path + (loc.start_line ? `:${loc.start_line}` : '') : '(unknown location)';
        return {
          ...(typeof a.number === 'number' ? { number: a.number } : {}),
          ruleId: a.rule?.id ?? a.rule?.name ?? '(unknown rule)',
          location,
          message: clip(
            a.most_recent_instance?.message?.text ?? a.rule?.description ?? '',
            CI_EVIDENCE_LIMITS.maxMessageChars,
          ),
        };
      });
    } catch (err) {
      errors.push(`code-scanning: ${errorMessage(err)}`);
    }
  }

  return { failingChecks, alerts, truncated, ...(errors.length > 0 ? { errors } : {}) };
}

const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
const ANSI_ESCAPE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/**
 * Download the log tails of the named failing Actions jobs on `ref` for non-CodeQL CI rework (#3537).
 * A check run's id is the Actions job id. Best-effort and GET-only: it never throws; a listing or
 * per-job failure is returned in `errors` and the remaining jobs are still fetched.
 */
export async function collectFailingJobLogs(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  checkNames: readonly string[];
}): Promise<{ jobLogs: CiJobLogExcerpt[]; errors: string[] }> {
  const { octokit, owner, repo, ref, checkNames } = opts;
  const jobLogs: CiJobLogExcerpt[] = [];
  const errors: string[] = [];
  let runs;
  try {
    const all = await listAllCheckRuns(octokit, owner, repo, ref, 100, 10);
    runs = all
      .filter((r) => r.status === 'completed' && !isPassingConclusion(r.conclusion))
      .filter((r) => r.name !== undefined && r.name !== null && checkNames.includes(r.name))
      .slice(0, CI_EVIDENCE_LIMITS.maxJobLogs);
  } catch (err) {
    return { jobLogs, errors: [`checks: ${errorMessage(err)}`] };
  }
  for (const run of runs) {
    const name = run.name ?? '(unnamed)';
    if (typeof run.id !== 'number') {
      errors.push(`${name}: no job id`);
      continue;
    }
    try {
      const { data } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: run.id });
      const text = typeof data === 'string' ? data : String(data);
      const lines = text.split('\n').map((l) => l.replace(LOG_TIMESTAMP, '').replace(ANSI_ESCAPE, ''));
      let truncated = lines.length > CI_EVIDENCE_LIMITS.maxLogLines;
      let excerpt = lines.slice(-CI_EVIDENCE_LIMITS.maxLogLines).join('\n');
      if (excerpt.length > CI_EVIDENCE_LIMITS.maxLogChars) {
        excerpt = excerpt.slice(-CI_EVIDENCE_LIMITS.maxLogChars);
        truncated = true;
      }
      jobLogs.push({ name, jobId: run.id, excerpt, truncated });
    } catch (err) {
      errors.push(`${name}: ${errorMessage(err)}`);
    }
  }
  return { jobLogs, errors };
}
