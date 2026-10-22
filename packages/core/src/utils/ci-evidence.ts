// packages/core/src/utils/ci-evidence.ts — bounded, read-only evidence for a SHIP CI-watch failure (#2814)

import type { Octokit } from '@octokit/rest';

import type { CiCodeScanningAlert, CiFailingCheck, CiFailureEvidence } from '../types/index.js';

import { isPassingConclusion, listAllCheckRuns } from './ci-watch.js';

export const CI_EVIDENCE_LIMITS = { maxChecks: 10, maxAlerts: 10, maxSummaryChars: 500, maxMessageChars: 300 } as const;

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
