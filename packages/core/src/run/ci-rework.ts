// packages/core/src/run/ci-rework.ts — attribution, budget and feedback for SHIP CI rework (#2816)

import type { Octokit } from '@octokit/rest';

import { isPassingConclusion, listAllCheckRuns } from '../utils/ci-watch.js';
import type {
  CheckSummary,
  CiAttribution,
  CiAttributionItem,
  CiCodeScanningAlert,
  CiFailingCheck,
  CiFailureEvidence,
  CiJobLogExcerpt,
} from '../types/index.js';

export const MAX_CI_REWORK_ROUNDS = 2;
export const CI_REWORK_ENV = 'FACTORY_MAX_CI_REWORK_ROUNDS';

const LIST_FILES_PAGE_SIZE = 100;
const LIST_FILES_MAX_PAGES = 30;
const BASE_ALERTS_PAGE_SIZE = 100;
const BASE_ALERTS_MAX_PAGES = 10;
const CODEQL_NEW_ALERTS = /new alerts? in code changed by this pull request/i;

export const CI_REWORK_INSTRUCTIONS =
  "CI (CodeQL) flagged the alerts above as introduced by this PR. A data-flow alert may sit in a file this PR did not change when the PR's changed code adds the flow to it. Fix the root cause in the code at the listed file:line or in the changed code that feeds it. " +
  'Suppression is forbidden: do not add `// codeql[...]`, `lgtm`, `eslint-disable` or `@ts-ignore` comments, do not exclude queries or paths in any config, and do not dismiss alerts. ' +
  'Commit the fix.';

export const CI_CHECK_REWORK_INSTRUCTIONS =
  'CI jobs above failed on this PR (merged with the latest base branch, which is now merged into your worktree). ' +
  'Reproduce the failure locally, fix the root cause in code or tests, and commit. ' +
  'Suppression is forbidden: do not raise any max-lines-baseline.json ceiling, do not lower coverage thresholds in vitest.config.ts, ' +
  'do not skip, delete or weaken failing tests, do not edit .github/workflows, and do not add eslint-disable or @ts-ignore comments.';

/** Non-negative integer from FACTORY_MAX_CI_REWORK_ROUNDS (0 disables CI rework); anything else falls back to the default. */
export function resolveMaxCiReworkRounds(env: NodeJS.ProcessEnv = process.env): number {
  const value = (env[CI_REWORK_ENV] ?? '').trim();
  return /^\d+$/.test(value) ? Number(value) : MAX_CI_REWORK_ROUNDS;
}

function alertPath(location: string): string | undefined {
  const trimmed = location.trim();
  if (trimmed === '' || trimmed === '(unknown location)') return undefined;
  const path = trimmed.replace(/:\d+$/, '').replace(/^\.\//, '');
  return path === '' ? undefined : path;
}

/** Open CodeQL alerts on the PR base branch (#3712). `refs` holds "ruleId at location" for alerts without a number. */
export interface BaseCodeqlAlerts {
  baseRef: string;
  numbers: number[];
  refs: string[];
}

/** True when a failing CodeQL check's summary says the PR introduced new alerts (#3712). */
export function codeqlReportsNewAlerts(evidence: CiFailureEvidence | undefined): boolean {
  return (
    !!evidence && evidence.failingChecks.some((c) => /codeql/i.test(c.name) && CODEQL_NEW_ALERTS.test(c.summary ?? ''))
  );
}

/** True when some alert sits in a file the PR did not change (or at an unknown location), so base alerts matter. */
export function needsBaseAlerts(evidence: CiFailureEvidence | undefined, changedFiles: readonly string[]): boolean {
  if (!evidence) return false;
  const changed = new Set(changedFiles);
  return evidence.alerts.some((alert) => {
    const path = alertPath(alert.location);
    return path === undefined || !changed.has(path);
  });
}

function classifyAlert(
  alert: CiCodeScanningAlert,
  changed: Set<string>,
  baseAlerts: BaseCodeqlAlerts | undefined,
  reportsNew: boolean,
): { attributable: boolean; reason: string } {
  const path = alertPath(alert.location);
  if (path !== undefined && changed.has(path)) return { attributable: true, reason: 'file changed by this PR' };
  if (baseAlerts) {
    const onBase =
      alert.number === undefined
        ? baseAlerts.refs.includes(`${alert.ruleId} at ${alert.location}`)
        : baseAlerts.numbers.includes(alert.number);
    return onBase
      ? { attributable: false, reason: `file not changed by this PR; also open on base ${baseAlerts.baseRef}` }
      : { attributable: true, reason: `not open on base ${baseAlerts.baseRef}` };
  }
  if (reportsNew) return { attributable: true, reason: 'CodeQL reports new alerts in code changed by this PR' };
  return { attributable: false, reason: 'file not changed by this PR' };
}

/** Alerts the PR introduced: in a changed file, or in an unchanged file but not open on base (or CodeQL says new). */
export function attributableCodeqlAlerts(
  evidence: CiFailureEvidence | undefined,
  changedFiles: readonly string[],
  baseAlerts?: BaseCodeqlAlerts,
): CiCodeScanningAlert[] {
  if (!evidence) return [];
  const changed = new Set(changedFiles);
  const reportsNew = codeqlReportsNewAlerts(evidence);
  return evidence.alerts.filter((alert) => classifyAlert(alert, changed, baseAlerts, reportsNew).attributable);
}

/** Failing check names on the PR base branch's latest commit (#2817). */
export interface BaseFailingChecks {
  baseRef: string;
  baseSha: string;
  failing: string[];
}

/** True when a failing check is attributed on its own (not through CodeQL alerts). */
export function needsBaseChecks(evidence: CiFailureEvidence | undefined): boolean {
  return !!evidence && evidence.failingChecks.some((c) => !(/codeql/i.test(c.name) && evidence.alerts.length > 0));
}

/** Attributes each failing item to the PR: alerts by changed file, then base alerts (#3712); other checks by the base commit (#2817). */
export function attributeCiFailure(
  evidence: CiFailureEvidence | undefined,
  changedFiles: readonly string[],
  base: BaseFailingChecks | undefined,
  baseAlerts?: BaseCodeqlAlerts,
): CiAttribution {
  if (!evidence) return { baseline: false, items: [] };
  const changed = new Set(changedFiles);
  const items: CiAttributionItem[] = [];
  const reportsNew = codeqlReportsNewAlerts(evidence);
  for (const alert of evidence.alerts) {
    items.push({
      kind: 'codeql-alert',
      ref: `${alert.ruleId} at ${alert.location}`,
      ...classifyAlert(alert, changed, baseAlerts, reportsNew),
    });
  }
  const baseLabel = base ? `${base.baseRef}@${base.baseSha.slice(0, 12)}` : '';
  for (const check of evidence.failingChecks) {
    if (/codeql/i.test(check.name) && evidence.alerts.length > 0) continue;
    if (!base) {
      items.push({ kind: 'check', ref: check.name, attributable: true, reason: 'base checks unavailable' });
      continue;
    }
    const onBase = base.failing.includes(check.name);
    items.push({
      kind: 'check',
      ref: check.name,
      attributable: !onBase,
      reason: onBase ? `also failing on base ${baseLabel}` : `not failing on base ${baseLabel}`,
    });
  }
  const baseline = items.length > 0 && items.every((i) => !i.attributable) && !evidence.errors?.length;
  return { baseline, ...(base ? { baseRef: base.baseRef, baseSha: base.baseSha } : {}), items };
}

/** Failing check names on the latest commit of the PR's base branch. Errors propagate to the caller. */
export async function listBaseFailingChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<BaseFailingChecks> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const baseRef = pr.base.ref;
  const { data: branch } = await octokit.rest.repos.getBranch({ owner, repo, branch: baseRef });
  const baseSha = branch.commit.sha;
  const runs = await listAllCheckRuns(octokit, owner, repo, baseSha, 100, 10);
  const failing = new Set<string>();
  for (const run of runs) {
    if (run.name && run.status === 'completed' && !isPassingConclusion(run.conclusion)) failing.add(run.name);
  }
  return { baseRef, baseSha, failing: [...failing] };
}

/** Open CodeQL alerts on the latest base branch of the PR. Errors propagate; a list that may be partial throws. */
export async function listBaseCodeqlAlerts(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<BaseCodeqlAlerts> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const baseRef = pr.base.ref;
  const numbers: number[] = [];
  const refs: string[] = [];
  for (let page = 1; page <= BASE_ALERTS_MAX_PAGES; page++) {
    const { data } = await octokit.rest.codeScanning.listAlertsForRepo({
      owner,
      repo,
      ref: `refs/heads/${baseRef}`,
      state: 'open',
      per_page: BASE_ALERTS_PAGE_SIZE,
      page,
    });
    for (const a of data) {
      numbers.push(a.number);
      const loc = a.most_recent_instance?.location;
      const location = loc?.path ? loc.path + (loc.start_line ? `:${loc.start_line}` : '') : '(unknown location)';
      refs.push(`${a.rule?.id ?? a.rule?.name ?? '(unknown rule)'} at ${location}`);
    }
    if (data.length < BASE_ALERTS_PAGE_SIZE) return { baseRef, numbers, refs };
  }
  throw new Error(`base CodeQL alert list exceeds ${BASE_ALERTS_PAGE_SIZE * BASE_ALERTS_MAX_PAGES} alerts`);
}

/** The same CheckSummary shape local CHECK rework consumes, with one FAIL `ci_codeql` result. */
export function ciReworkSummary(alerts: readonly CiCodeScanningAlert[]): CheckSummary {
  const lines = alerts.map((a) => `- ${a.ruleId} at ${a.location} — ${a.message}`);
  const details = ['CodeQL alerts this PR introduced:', ...lines].join('\n');
  return {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'ci_codeql', result: 'FAIL', details }],
  };
}

/** The same CheckSummary shape, with one FAIL `ci_checks` result listing failing jobs and their log tails (#3537). */
export function ciCheckReworkSummary(
  checks: readonly CiFailingCheck[],
  jobLogs: readonly CiJobLogExcerpt[],
  errors: readonly string[],
): CheckSummary {
  const lines = checks.map((c) => `- ${c.name} (${c.conclusion})${c.summary ? ` — ${c.summary}` : ''}`);
  const logs = jobLogs.map(
    (l) => `\n--- ${l.name} log tail (job ${l.jobId})${l.truncated ? ', truncated' : ''} ---\n${l.excerpt}`,
  );
  const details = [
    'CI jobs failing on this PR (not failing on the base branch):',
    ...lines,
    ...logs,
    ...(errors.length > 0 ? [`Log fetch errors: ${errors.join('; ')}`] : []),
  ].join('\n');
  return {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'ci_checks', result: 'FAIL', details }],
  };
}

export async function listPrChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= LIST_FILES_MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: LIST_FILES_PAGE_SIZE,
      page,
    });
    files.push(...data.map((f) => f.filename));
    if (data.length < LIST_FILES_PAGE_SIZE) break;
  }
  return files;
}
