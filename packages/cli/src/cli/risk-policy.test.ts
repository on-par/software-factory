// packages/cli/src/cli/risk-policy.test.ts — doctor risk-policy row and land risk-policy lines (#3387)

import { loadRiskPolicy, type RiskPolicy } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { riskPolicyCheck, riskPolicyLines } from './risk-policy.js';

const rules: RiskPolicy['rules'] = {
  rules: [
    { id: 'a', tier: 'high', globs: ['a/**'] },
    { id: 'b', tier: 'low', globs: ['b/**'] },
  ],
};
const ok = (): RiskPolicy => ({ source: 'repo', file: '.factory/config.yaml', rules });
const bad = (): RiskPolicy => {
  throw new Error('boom');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('riskPolicyCheck', () => {
  it('returns an ok Repo row with the joined summary', () => {
    expect(riskPolicyCheck('/r', ok)).toEqual({
      name: 'risk policy',
      section: 'Repo',
      ok: true,
      detail: '.factory/config.yaml `risk` (2 rules); high: a; low: b',
    });
  });

  it('returns an optional failing row with a fix when loading throws', () => {
    const check = riskPolicyCheck('/r', bad);
    expect(check.ok).toBe(false);
    expect(check.optional).toBe(true);
    expect(check.detail).toBe('boom');
    expect(check.fix).toBe(
      'fix the `risk` section of .factory/config.yaml (schema: packages/config/src/risk.ts) or remove it to use the packaged defaults',
    );
  });

  it('names the generic config file in the fix when the config path cannot resolve', () => {
    vi.stubEnv('FACTORY_STATE_ROOT', 'auto');
    const check = riskPolicyCheck('/nonexistent-repo-root');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('FACTORY_STATE_ROOT=auto');
    expect(check.fix).toContain('of .factory/config.yaml ');
  });

  it('loads the packaged defaults for a repo without a config file', () => {
    expect(riskPolicyCheck('/nonexistent-repo-root').detail).toContain('no risk policy configured');
  });
});

describe('riskPolicyLines', () => {
  it('prefixes the summary, indents tier lines, and returns the rules', () => {
    expect(riskPolicyLines('/r', ok)).toEqual({
      lines: ['risk policy: .factory/config.yaml `risk` (2 rules)', '  high: a', '  low: b'],
      rules,
    });
  });

  it('returns one invalid line and no rules when loading throws', () => {
    const res = riskPolicyLines('/r', bad);
    expect(res.rules).toBeUndefined();
    expect(res.lines).toEqual(['risk policy: boom; the risk receipt uses the packaged defaults']);
  });

  it('returns the packaged defaults when no config file exists', () => {
    expect(riskPolicyLines('/nonexistent-repo-root').rules).toBe(loadRiskPolicy('/nonexistent-repo-root').rules);
  });
});
