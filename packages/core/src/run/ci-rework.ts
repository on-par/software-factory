// packages/core/src/run/ci-rework.ts — attribution, budget and feedback for SHIP CI rework (#2816)

import type { Octokit } from '@octokit/rest';

import type { CheckSummary, CiCodeScanningAlert, CiFailureEvidence } from '../types/index.js';

export const MAX_CI_REWORK_ROUNDS = 2;
export const CI_REWORK_ENV = 'FACTORY_MAX_CI_REWORK_ROUNDS';

const LIST_FILES_PAGE_SIZE = 100;
const LIST_FILES_MAX_PAGES = 30;

export const CI_REWORK_INSTRUCTIONS =
  'CI (CodeQL) flagged the alerts above on files this PR changed. Fix the root cause in the code at the listed file:line. ' +
  'Suppression is forbidden: do not add `// codeql[...]`, `lgtm`, `eslint-disable` or `@ts-ignore` comments, do not exclude queries or paths in any config, and do not dismiss alerts. ' +
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

/** The same CheckSummary shape local CHECK rework consumes, with one FAIL `ci_codeql` result. */
export function ciReworkSummary(alerts: readonly CiCodeScanningAlert[]): CheckSummary {
  const lines = alerts.map((a) => `- ${a.ruleId} at ${a.location} — ${a.message}`);
  const details = ['CodeQL alerts on files this PR changed:', ...lines].join('\n');
  return {
    failures: 1,
    passes: 0,
    skips: 0,
    total: 1,
    results: [{ checker: 'ci_codeql', result: 'FAIL', details }],
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
