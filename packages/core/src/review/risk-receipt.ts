// packages/core/src/review/risk-receipt.ts — Risk receipt in the PR body (#3386) and the repo risk policy loader (#3387)

import { isAbsolute, relative, resolve } from 'node:path';

import type { Octokit } from '@octokit/rest';
import {
  DEFAULT_RISK_RULES,
  parseRiskRules,
  RISK_TIERS,
  RiskRulesError,
  type RiskRuleSet,
} from '@on-par/factory-config';

import { getFactoryPaths, isPlainObject } from '../config/index.js';
import { readRepoConfigFile } from '../config/repo-config-file.js';
import { listPrChangedFiles } from '../run/ci-rework.js';
import { evaluateRisk, type RiskEvaluation } from './risk.js';

export const RISK_RECEIPT_START = '<!-- factory:risk-receipt v1 -->';
export const RISK_RECEIPT_END = '<!-- /factory:risk-receipt -->';

export interface PublishRiskReceiptResult {
  evaluation: RiskEvaluation;
  /** false when the PR body already held this exact receipt (no API write). */
  updated: boolean;
}

/** Render the evaluation as a marked markdown block for the PR body. */
export function renderRiskReceipt(evaluation: RiskEvaluation): string {
  const rows = evaluation.rules.map(
    (rule) => `- \`${rule.id}\`: ${rule.tier} risk (${rule.id === 'empty-diff' ? 'diff is empty' : 'rule matched'}).`,
  );
  return [
    RISK_RECEIPT_START,
    '### Risk receipt',
    '',
    `**Tier: ${evaluation.tier}**`,
    '',
    ...rows,
    '',
    "_Computed by the factory from the PR's changes. Regenerated on each land._",
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

/** Display path of the repo config file that holds the `risk` section (#3387): repo-relative when
 *  it sits under the repo (`.factory/config.yaml`), else absolute (an outside state root). */
export function riskPolicyConfigFile(repoRoot: string): string {
  const path = getFactoryPaths(repoRoot).config;
  const rel = relative(resolve(repoRoot), path);
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

export interface RiskPolicy {
  /** 'repo' when the repo config file has a valid `risk` section, 'default' for the packaged rules. */
  source: 'repo' | 'default';
  /** The repo config file the policy was read from, as riskPolicyConfigFile returns it. */
  file: string;
  rules: RiskRuleSet;
}

/** Load the `risk` section of the repo config file (`.factory/config.yaml|yml|json`), or the
 *  packaged defaults when the file or the section is absent. A malformed file propagates the
 *  reader's error; an invalid section throws a RiskRulesError naming the file and the `risk` key. */
export function loadRiskPolicy(repoRoot: string): RiskPolicy {
  const file = riskPolicyConfigFile(repoRoot);
  const raw = readRepoConfigFile(getFactoryPaths(repoRoot).config);
  const section = isPlainObject(raw) ? raw.risk : undefined;
  if (section === undefined) return { source: 'default', file, rules: DEFAULT_RISK_RULES };
  try {
    return { source: 'repo', file, rules: parseRiskRules(section) };
  } catch (err) {
    // parseRiskRules throws only RiskRulesError.
    const { message, ruleId, index } = err as RiskRulesError;
    throw new RiskRulesError(`invalid \`risk\` section in ${file}: ${message}`, ruleId, index);
  }
}

/** Summary line, one `<tier>: <rule ids>` line per non-empty tier (high first), then the refactor allowlist. */
export function formatRiskPolicy(policy: RiskPolicy): string[] {
  const n = policy.rules.rules.length;
  const count = `${n} ${n === 1 ? 'rule' : 'rules'}`;
  const summary =
    policy.source === 'repo'
      ? `${policy.file} \`risk\` (${count})`
      : `no risk policy configured (no \`risk\` section in ${policy.file}); using the packaged defaults (${count})`;
  const lines = [summary];
  for (const tier of [...RISK_TIERS].reverse()) {
    const ids = policy.rules.rules.filter((r) => r.tier === tier).map((r) => r.id);
    if (ids.length > 0) lines.push(`${tier}: ${ids.join(', ')}`);
  }
  const globs = policy.rules.refactorAllowlist ?? [];
  if (globs.length > 0) lines.push(`refactor allowlist: ${globs.join(', ')}`);
  return lines;
}
