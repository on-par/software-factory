// packages/cli/src/cli/land-risk.ts — risk tier gate on the autonomous merge path (#3381)

import type { Octokit } from '@octokit/rest';
import type { EventKind } from '@on-par/factory-core';
import {
  decideRiskMerge,
  evaluateRisk,
  RISK_HIGH_LABEL,
  type RiskEvaluation,
  type TrustTier,
} from '@on-par/factory-core/internal';

const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const MAX_PATHS_PER_RULE = 10;

/** Every path a PR touches (new and previous names), paged; GitHub caps a PR at 3000 files. */
export async function listPullRequestPaths(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: PAGE_SIZE,
      page,
    });
    for (const file of data) {
      out.push(file.filename);
      if (file.previous_filename) out.push(file.previous_filename);
    }
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

export interface RiskGateInput {
  octokit: Octokit;
  owner: string;
  repoName: string;
  issue: number;
  prNumber: number;
  /** Issue and PR labels, combined. */
  labels: readonly string[];
  trustTier: TrustTier;
  log: (type: EventKind, msg: string) => void;
}

export type RiskGateOutcome =
  { merge: true; risk: RiskEvaluation } | { merge: false; reason: string; risk?: RiskEvaluation };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function highRiskComment(prNumber: number, summary: string, risk: RiskEvaluation): string {
  const rules = risk.rules.map((r) => {
    const shown = r.paths.slice(0, MAX_PATHS_PER_RULE).map((p) => `  - \`${p}\``);
    const more = r.paths.length > MAX_PATHS_PER_RULE ? [`  - … ${r.paths.length - MAX_PATHS_PER_RULE} more`] : [];
    return [`- ${r.id} (${r.tier})`, ...shown, ...more].join('\n');
  });
  return [
    '<!-- factory:risk-high -->',
    `High-risk PR #${prNumber} held for human review (Patrick): auto-merge is blocked.`,
    '',
    summary,
    '',
    ...rules,
    '',
    'Merge it by hand once reviewed (GitHub, or `factory land <issue>`).',
  ].join('\n');
}

/** Decide whether the autonomous merge may proceed; on a hold, label the PR and notify on the issue. */
export async function enforceRiskAtLand(input: RiskGateInput): Promise<RiskGateOutcome> {
  const { octokit, owner, repoName, issue, prNumber, labels, trustTier, log } = input;
  let paths: string[];
  try {
    paths = await listPullRequestPaths(octokit, owner, repoName, prNumber);
  } catch (err) {
    const reason = `risk could not be evaluated for PR #${prNumber} (${errMessage(err)}) — failing closed`;
    log('merge-gated', reason);
    return { merge: false, reason };
  }

  const risk = evaluateRisk({ paths });
  const decision = decideRiskMerge({ tier: risk.tier, trustTier, labels });
  const summary = `risk ${risk.tier} (rules: ${risk.rules.map((r) => r.id).join(', ')}), trust tier ${trustTier}`;
  if (decision.merge) {
    log('land', `${summary} — eligible for auto-merge`);
    return { merge: true, risk };
  }

  const missing = decision.addLabels.filter((l) => !labels.includes(l));
  if (missing.length > 0) {
    try {
      await octokit.rest.issues.addLabels({ owner, repo: repoName, issue_number: prNumber, labels: missing });
    } catch (err) {
      log('warn', `could not label PR #${prNumber} ${missing.join(', ')}: ${errMessage(err)}`);
    }
  }
  if (decision.notify && !labels.includes(RISK_HIGH_LABEL)) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo: repoName,
        issue_number: issue,
        body: highRiskComment(prNumber, summary, risk),
      });
    } catch (err) {
      log('warn', `could not notify on issue #${issue} about high-risk PR #${prNumber}: ${errMessage(err)}`);
    }
  }
  const reason = `${summary} — ${decision.reason}`;
  log('merge-gated', `${reason}; auto-merge held for a human`);
  return { merge: false, reason, risk };
}
