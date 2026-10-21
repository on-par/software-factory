// packages/core/src/review/risk-receipt.ts — Risk receipt in the PR body (#3386) and the repo risk policy loader (#3387)

import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { DEFAULT_RISK_RULES, parseRiskRules, RISK_TIERS, type RiskRuleSet } from '@on-par/factory-config';

import { readRepoConfigFile } from '../config/repo-config-file.js';
import { listPrChangedFiles } from '../run/ci-rework.js';
import { evaluateRisk, type RiskEvaluation } from './risk.js';

export const RISK_RECEIPT_START = '<!-- factory:risk-receipt v1 -->';
export const RISK_RECEIPT_END = '<!-- /factory:risk-receipt -->';
const MAX_PATHS_PER_RULE = 10;

export interface PublishRiskReceiptResult {
  evaluation: RiskEvaluation;
  /** false when the PR body already held this exact receipt (no API write). */
  updated: boolean;
}

function cell(path: string): string {
  return `\`${path.replaceAll('`', '').replaceAll('|', '\\|')}\``;
}

/** Render the evaluation as a marked markdown block for the PR body. */
export function renderRiskReceipt(evaluation: RiskEvaluation): string {
  const rows = evaluation.rules.map((rule) => {
    const shown = rule.paths.slice(0, MAX_PATHS_PER_RULE).map(cell);
    const extra = rule.paths.length - shown.length;
    const parts = extra > 0 ? [...shown, `… and ${extra} more`] : shown;
    return `| \`${rule.id}\` | ${rule.tier} | ${parts.length > 0 ? parts.join(', ') : '(none)'} |`;
  });
  return [
    RISK_RECEIPT_START,
    '### Risk receipt',
    '',
    `**Tier: ${evaluation.tier}**`,
    '',
    '| Rule | Tier | Paths |',
    '| --- | --- | --- |',
    ...rows,
    '',
    "_Computed by the factory from the PR's changed paths. Regenerated on each land._",
    RISK_RECEIPT_END,
  ].join('\n');
}

function blockEnd(text: string, start: number): number {
  const end = text.indexOf(RISK_RECEIPT_END, start + RISK_RECEIPT_START.length);
  return end === -1 ? text.length : end + RISK_RECEIPT_END.length;
}

/** Swap the marked block in a PR body for `receipt`, or append it when absent. */
export function upsertRiskReceipt(body: string | null | undefined, receipt: string): string {
  const current = body ?? '';
  const first = current.indexOf(RISK_RECEIPT_START);
  if (first === -1) {
    return current.trim() === '' ? receipt : `${current.trimEnd()}\n\n${receipt}\n`;
  }
  const head = current.slice(0, first);
  let tail = current.slice(blockEnd(current, first));
  let next = tail.indexOf(RISK_RECEIPT_START);
  while (next !== -1) {
    const before = tail.slice(0, next).trimEnd();
    const after = tail.slice(blockEnd(tail, next)).trimStart();
    tail = before !== '' && after !== '' ? `${before}\n\n${after}` : `${before}${after}`;
    next = tail.indexOf(RISK_RECEIPT_START);
  }
  return `${head}${receipt}${tail}`;
}

export async function publishRiskReceipt(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  rules?: RiskRuleSet;
}): Promise<PublishRiskReceiptResult> {
  const { octokit, owner, repo, prNumber, rules } = opts;
  const paths = await listPrChangedFiles(octokit, owner, repo, prNumber);
  const evaluation = evaluateRisk(rules ? { paths, rules } : { paths });
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const next = upsertRiskReceipt(data.body, renderRiskReceipt(evaluation));
  if (next === (data.body ?? '')) return { evaluation, updated: false };
  await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body: next });
  return { evaluation, updated: true };
}

/** Repo-relative path of the repo risk policy file (#3387). */
export const RISK_POLICY_FILE = '.factory/risk.yml';

export interface RiskPolicy {
  /** 'repo' when RISK_POLICY_FILE exists and validates, 'default' for the packaged rules. */
  source: 'repo' | 'default';
  rules: RiskRuleSet;
}

/** Load <repoRoot>/.factory/risk.yml, or the packaged defaults when it is absent.
 *  YAML errors and RiskRulesError propagate; callers decide how to report them. */
export function loadRiskPolicy(repoRoot: string): RiskPolicy {
  const raw = readRepoConfigFile(join(repoRoot, RISK_POLICY_FILE));
  if (raw === undefined) return { source: 'default', rules: DEFAULT_RISK_RULES };
  return { source: 'repo', rules: parseRiskRules(raw) };
}

/** Summary line, one `<tier>: <rule ids>` line per non-empty tier (high first), then the refactor allowlist. */
export function formatRiskPolicy(policy: RiskPolicy): string[] {
  const n = policy.rules.rules.length;
  const count = `${n} ${n === 1 ? 'rule' : 'rules'}`;
  const summary =
    policy.source === 'repo'
      ? `${RISK_POLICY_FILE} (${count})`
      : `no risk policy configured (${RISK_POLICY_FILE} not found); using the packaged defaults (${count})`;
  const lines = [summary];
  for (const tier of [...RISK_TIERS].reverse()) {
    const ids = policy.rules.rules.filter((r) => r.tier === tier).map((r) => r.id);
    if (ids.length > 0) lines.push(`${tier}: ${ids.join(', ')}`);
  }
  const globs = policy.rules.refactorAllowlist ?? [];
  if (globs.length > 0) lines.push(`refactor allowlist: ${globs.join(', ')}`);
  return lines;
}
