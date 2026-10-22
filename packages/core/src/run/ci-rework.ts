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
} from '../types/index.js';

export const MAX_CI_REWORK_ROUNDS = 2;
export const CI_REWORK_ENV = 'FACTORY_MAX_CI_REWORK_ROUNDS';

const LIST_FILES_PAGE_SIZE = 100;
const LIST_FILES_MAX_PAGES = 30;

export const CI_REWORK_INSTRUCTIONS =
  'CI (CodeQL) flagged the alerts above on files this PR changed. Fix the root cause in the code at the listed file:line. ' +
  'Suppression is forbidden: do not add `// codeql[...]`, `lgtm`, `eslint-disable` or `@ts-ignore` comments, do not exclude queries or paths in any config, and do not dismiss alerts. ' +
  'Commit the fix.';

export const CI_JOB_REWORK_INSTRUCTIONS =
  'The CI jobs listed above failed on this PR merged with the current base, and the base is already merged into your branch. ' +
  'Reproduce the failure locally (run the failing test or script) and fix the root cause. ' +
  'Suppression is forbidden: do not skip or delete tests, do not add `.skip` or `.only`, do not raise a `max-lines-baseline.json` ceiling, do not lower a `vitest.config.ts` threshold, and do not edit CI workflows. ' +
  'Commit the fix.';

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

/** Alerts whose file is among the PR's changed files; the rest are pre-existing or baseline. */
export function attributableCodeqlAlerts(
  evidence: CiFailureEvidence | undefined,
  changedFiles: readonly string[],
): CiCodeScanningAlert[] {
  if (!evidence) return [];
  const changed = new Set(changedFiles);
  return evidence.alerts.filter((alert) => {
    const path = alertPath(alert.location);
    return path !== undefined && changed.has(path);
  });
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

/** Attributes each failing item to the PR: alerts by changed file, other checks by the base commit (#2817). */
export function attributeCiFailure(
  evidence: CiFailureEvidence | undefined,
  changedFiles: readonly string[],
  base: BaseFailingChecks | undefined,
): CiAttribution {
  if (!evidence) return { baseline: false, items: [] };
  const changed = new Set(changedFiles);
  const items: CiAttributionItem[] = [];
  for (const alert of evidence.alerts) {
    const path = alertPath(alert.location);
    const attributable = path !== undefined && changed.has(path);
    items.push({
      kind: 'codeql-alert',
      ref: `${alert.ruleId} at ${alert.location}`,
      attributable,
      reason: attributable ? 'file changed by this PR' : 'file not changed by this PR',
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

/** Failing non-CodeQL checks attributed to this PR (not also failing on base), with their log excerpts. */
export function attributableFailingChecks(
  evidence: CiFailureEvidence | undefined,
  attribution: CiAttribution,
): CiFailingCheck[] {
  if (!evidence) return [];
  const names = new Set(
    attribution.items.filter((i) => i.kind === 'check' && i.attributable && !/codeql/i.test(i.ref)).map((i) => i.ref),
  );
  return evidence.failingChecks.filter((c) => names.has(c.name) && !/codeql/i.test(c.name));
}

/** The same CheckSummary shape local CHECK rework consumes: a FAIL `ci_codeql` result for alerts and one `ci_job` per failing job. */
export function ciReworkSummary(
  alerts: readonly CiCodeScanningAlert[],
  checks: readonly CiFailingCheck[] = [],
): CheckSummary {
  const results: CheckSummary['results'] = [];
  if (alerts.length > 0) {
    const lines = alerts.map((a) => `- ${a.ruleId} at ${a.location} — ${a.message}`);
    results.push({
      checker: 'ci_codeql',
      result: 'FAIL',
      details: ['CodeQL alerts on files this PR changed:', ...lines].join('\n'),
    });
  }
  for (const c of checks) {
    results.push({
      checker: 'ci_job',
      result: 'FAIL',
      details: `CI job "${c.name}" (${c.conclusion}) failed on the PR merge ref. Last log lines:\n${c.logExcerpt ?? c.summary ?? '(no log available)'}`,
    });
  }
  return { failures: results.length, passes: 0, skips: 0, total: results.length, results };
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
