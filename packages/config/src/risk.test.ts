import { describe, expect, it } from 'vitest';

import { DEFAULT_RISK_RULES, parseRiskRules, RISK_TIERS, RiskRulesError } from './risk.js';

const rule = (extra: Record<string, unknown> = {}) => ({ id: 'r1', tier: 'low', globs: ['x'], ...extra });
const failure = (raw: unknown): RiskRulesError => {
  try {
    parseRiskRules(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(RiskRulesError);
    return err as RiskRulesError;
  }
  throw new Error('expected parseRiskRules to throw');
};

describe('parseRiskRules', () => {
  it('accepts DEFAULT_RISK_RULES', () => {
    const out = parseRiskRules(DEFAULT_RISK_RULES);
    expect(out).toEqual(DEFAULT_RISK_RULES);
    expect(out).not.toBe(DEFAULT_RISK_RULES);
  });

  it('accepts a minimal valid set with globs, patterns, a predicate function and refactorAllowlist', () => {
    const predicate = (p: string) => p.length > 3;
    const out = parseRiskRules({
      rules: [
        { id: 'a', tier: 'high', description: 'd', globs: ['a/**'], patterns: ['^b'] },
        { id: 'p', tier: 'med', predicate },
      ],
      refactorAllowlist: ['src/ok/**'],
    });
    expect(out.rules[0]).toEqual({ id: 'a', tier: 'high', description: 'd', globs: ['a/**'], patterns: ['^b'] });
    expect(out.rules[1]!.predicate).toBe(predicate);
    expect(out.refactorAllowlist).toEqual(['src/ok/**']);
  });

  it('rejects an invalid rule with an error naming the rule', () => {
    const err = failure({ rules: [{ id: 'bad-tier', tier: 'critical', globs: ['x'] }] });
    expect(err.message).toContain('"bad-tier"');
    expect(err.message).toContain('rules[0]');
    expect(err.message).toContain('low, med, high');
    expect(err.ruleId).toBe('bad-tier');
    expect(err.index).toBe(0);
    expect(RISK_TIERS).toEqual(['low', 'med', 'high']);
  });

  it('rejects a non-object raw value', () => {
    expect(failure([]).message).toMatch(/^invalid risk rules: /);
    expect(failure(null).message).toMatch(/^invalid risk rules: /);
  });

  it('rejects rules that is not an array', () => {
    expect(failure({ rules: {} }).message).toContain('"rules" must be an array');
  });

  it('rejects an unknown top-level key', () => {
    expect(failure({ rules: [], extra: 1 }).message).toContain('"extra"');
  });

  it('rejects a rule that is not an object', () => {
    const err = failure({ rules: ['x'] });
    expect(err.message).toContain('invalid risk rule at rules[0]: ');
    expect(err.ruleId).toBeUndefined();
  });

  it('rejects a missing or invalid id using rules[i]', () => {
    expect(failure({ rules: [{ tier: 'low', globs: ['x'] }] }).message).toContain('at rules[0]');
    const err = failure({ rules: [rule(), rule({ id: 'Bad_Id' })] });
    expect(err.message).toContain('"Bad_Id" (rules[1])');
  });

  it('rejects a non-string id without naming it', () => {
    expect(failure({ rules: [rule({ id: 5 })] }).message).toContain('at rules[0]');
  });

  it('rejects a duplicate id', () => {
    const err = failure({ rules: [rule(), rule()] });
    expect(err.message).toContain('duplicate id "r1"');
    expect(err.index).toBe(1);
  });

  it('rejects an unknown rule key', () => {
    expect(failure({ rules: [rule({ nope: 1 })] }).message).toContain('unknown key "nope"');
  });

  it('rejects a non-string description', () => {
    expect(failure({ rules: [rule({ description: 3 })] }).message).toContain('description must be a string');
  });

  it('rejects globs or patterns that are not arrays', () => {
    expect(failure({ rules: [rule({ globs: 'x' })] }).message).toContain('globs must be an array');
    expect(failure({ rules: [rule({ patterns: 'x' })] }).message).toContain('patterns must be an array');
  });

  it('rejects empty-string and non-string entries', () => {
    expect(failure({ rules: [rule({ globs: [''] })] }).message).toContain('non-empty strings');
    expect(failure({ rules: [rule({ patterns: [1] })] }).message).toContain('non-empty strings');
  });

  it('rejects an uncompilable pattern and names it', () => {
    const err = failure({ rules: [rule({ patterns: ['('] })] });
    expect(err.message).toContain('pattern "("');
    expect(err.message).toContain('does not compile');
  });

  it('rejects a string predicate', () => {
    expect(failure({ rules: [rule({ predicate: 'return true' })] }).message).toContain(
      'predicate must be a function; string predicates from config are not evaluated',
    );
  });

  it('rejects a non-function predicate', () => {
    expect(failure({ rules: [rule({ predicate: 1 })] }).message).toContain('predicate must be a function');
  });

  it('rejects a rule with no matcher', () => {
    expect(failure({ rules: [{ id: 'none', tier: 'low' }] }).message).toContain('at least one matcher');
    expect(failure({ rules: [{ id: 'none', tier: 'low', globs: [] }] }).message).toContain('at least one matcher');
  });

  it('rejects a bad refactorAllowlist', () => {
    expect(failure({ rules: [], refactorAllowlist: 'x' }).message).toContain('refactorAllowlist');
    expect(failure({ rules: [], refactorAllowlist: [''] }).message).toContain('refactorAllowlist');
  });

  it('does not mutate its input', () => {
    const input = { rules: [rule()] };
    const snapshot = structuredClone(input);
    parseRiskRules(input);
    expect(input).toEqual(snapshot);
  });
});

describe('DEFAULT_RISK_RULES', () => {
  it('has rules in every tier and unique ids', () => {
    const tiers = new Set(DEFAULT_RISK_RULES.rules.map((r) => r.tier));
    expect([...tiers].sort()).toEqual(['high', 'low', 'med']);
    const ids = DEFAULT_RISK_RULES.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
