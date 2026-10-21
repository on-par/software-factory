// packages/core/src/review/risk.ts — Deterministic risk tier from changed paths (#3380)
//
// Pure: no I/O, no clock, never mutates its input. Each path takes the highest
// tier among the rules matching it; the result is the highest tier overall.

import { DEFAULT_RISK_RULES, RISK_TIERS, type RiskRuleSet, type RiskTier } from '@on-par/factory-config';

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
