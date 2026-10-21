// packages/core/src/review/risk-receipt.ts — Risk receipt in the PR body (#3386)

import type { Octokit } from '@octokit/rest';
import type { RiskRuleSet } from '@on-par/factory-config';

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
