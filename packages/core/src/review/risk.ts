// packages/core/src/review/risk.ts — Deterministic risk tier from changed paths (#3380)
//
// Pure: no I/O, no clock, never mutates its input. Each path takes the highest
// tier among the rules matching it; the result is the highest tier overall.

import { DEFAULT_RISK_RULES, RISK_TIERS, type RiskRuleSet, type RiskTier } from '@on-par/factory-config';

import type { TrustTier } from '../config/repo.js';
import { globToRegExp } from './floor.js';

export interface RiskEvaluationInput {
  paths: readonly string[];
  rules?: RiskRuleSet;
}

export interface RiskMatchedRule {
  id: string;
  tier: RiskTier;
  paths: string[];
}

export interface RiskEvaluation {
  tier: RiskTier;
  rules: RiskMatchedRule[];
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluation {
  if (input.paths.length === 0) {
    return { tier: 'med', rules: [{ id: 'empty-diff', tier: 'med', paths: [] }] };
  }
  const ruleSet = input.rules ?? DEFAULT_RISK_RULES;

  const invalid: string[] = [];
  const normalized: string[] = [];
  for (const p of input.paths) {
    const path = typeof p === 'string' ? normalizePath(p) : '';
    if (path === '') invalid.push(typeof p === 'string' ? p : '');
    else normalized.push(path);
  }
  const validPaths = [...new Set(normalized)];

  const predicateErrors: string[] = [];
  const matched: RiskMatchedRule[] = [];
  const covered = new Set<string>();
  for (const rule of ruleSet.rules) {
    const globs = (rule.globs ?? []).map(globToRegExp);
    const patterns = (rule.patterns ?? []).map((src) => new RegExp(src, 'i'));
    const paths = validPaths.filter((path) => {
      if (globs.some((g) => g.test(path)) || patterns.some((r) => r.test(path))) return true;
      if (rule.predicate === undefined) return false;
      try {
        return rule.predicate(path);
      } catch {
        if (!predicateErrors.includes(path)) predicateErrors.push(path);
        return false;
      }
    });
    if (paths.length === 0) continue;
    matched.push({ id: rule.id, tier: rule.tier, paths });
    for (const path of paths) covered.add(path);
  }

  const allow = (ruleSet.refactorAllowlist ?? []).map(globToRegExp);
  const allowlisted = validPaths.filter((path) => allow.some((g) => g.test(path)));
  const unmatched = validPaths.filter((path) => !covered.has(path) && !allowlisted.includes(path));

  const synthetic: RiskMatchedRule[] = [
    { id: 'allowlisted-refactor', tier: 'low', paths: allowlisted },
    { id: 'unmatched', tier: 'med', paths: unmatched },
    { id: 'predicate-error', tier: 'high', paths: predicateErrors },
    { id: 'invalid-input', tier: 'high', paths: invalid },
  ];
  const rules = [...matched, ...synthetic.filter((r) => r.paths.length > 0)];

  let top = 0;
  for (const r of rules) top = Math.max(top, RISK_TIERS.indexOf(r.tier));
  return { tier: RISK_TIERS[top]!, rules };
}

export const RISK_MED_LABEL = 'risk:med';
export const RISK_HIGH_LABEL = 'risk:high';
export const NEEDS_HUMAN_LABEL = 'needs-human';

export interface RiskMergeInput {
  tier: RiskTier;
  trustTier: TrustTier;
  /** Labels on the issue and the PR, combined. */
  labels: readonly string[];
}

export interface RiskMergeDecision {
  merge: boolean;
  /** Labels to add to the PR. Only risk:med, risk:high and needs-human, never a queue label. */
  addLabels: string[];
  notify: boolean;
  reason: string;
}

/** Whether an autonomous merge may proceed for a risk tier under a trust tier. Unknown tiers fail closed as high. */
export function decideRiskMerge(input: RiskMergeInput): RiskMergeDecision {
  const { tier, trustTier, labels } = input;
  if (tier === 'low') return { merge: true, addLabels: [], notify: false, reason: 'risk low' };
  if (tier === 'med') {
    const needsHuman = labels.includes(NEEDS_HUMAN_LABEL);
    if (trustTier === 'T2' && !needsHuman)
      return { merge: true, addLabels: [], notify: false, reason: 'risk med on T2' };
    const cause = trustTier === 'T2' ? `${NEEDS_HUMAN_LABEL} is set` : `trust tier ${trustTier} is not T2`;
    return { merge: false, addLabels: [RISK_MED_LABEL], notify: false, reason: `risk med: ${cause}` };
  }
  return {
    merge: false,
    addLabels: [RISK_HIGH_LABEL, NEEDS_HUMAN_LABEL],
    notify: true,
    reason: tier === 'high' ? 'risk high' : `unknown risk tier ${String(tier)} treated as high`,
  };
}
