import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_RISK_RULES, RiskRulesError, type RiskRuleSet } from '@on-par/factory-config';
import { createTempDirs } from '../harness/temp-dir.js';
import { describe, expect, it, vi } from 'vitest';

import type { RiskEvaluation } from './risk.js';
import {
  formatRiskPolicy,
  loadRiskPolicy,
  publishRiskReceipt,
  renderRiskReceipt,
  RISK_RECEIPT_END,
  RISK_RECEIPT_START,
  riskPolicyConfigFile,
  upsertRiskReceipt,
} from './risk-receipt.js';

const evaluation: RiskEvaluation = {
  tier: 'high',
  rules: [
    { id: 'auth', tier: 'high', paths: ['src/auth/login.ts', 'src/auth/session.ts'] },
    { id: 'docs', tier: 'low', paths: ['README.md'] },
  ],
};

describe('renderRiskReceipt', () => {
  it('renders one path-free reason for each matched rule', () => {
    const out = renderRiskReceipt(evaluation);
    expect(out).toContain('**Tier: high**');
    expect(out).toContain('- `auth`: high risk (rule matched).');
    expect(out).toContain('- `docs`: low risk (rule matched).');
    expect(out).not.toContain('Paths');
    for (const rule of evaluation.rules) for (const path of rule.paths) expect(out).not.toContain(path);
    expect(renderRiskReceipt({ tier: 'med', rules: [{ id: 'empty-diff', tier: 'med', paths: [] }] })).toContain(
      'diff is empty',
    );
    expect(renderRiskReceipt({ tier: 'low', rules: [] })).toContain('**Tier: low**');
  });
});

describe('upsertRiskReceipt', () => {
  const receipt = renderRiskReceipt(evaluation);
  const old = `${RISK_RECEIPT_START}\nold\n${RISK_RECEIPT_END}`;

  it('appends to a non-empty body and returns the receipt alone for an empty one', () => {
    expect(upsertRiskReceipt('Closes #5', receipt)).toBe(`Closes #5\n\n${receipt}\n`);
    expect(upsertRiskReceipt('', receipt)).toBe(receipt);
    expect(upsertRiskReceipt(null, receipt)).toBe(receipt);
    expect(upsertRiskReceipt(undefined, receipt)).toBe(receipt);
  });

  it('replaces an existing receipt in place instead of appending a second one', () => {
    const out = upsertRiskReceipt(`intro\n\n${old}\n\noutro`, receipt);
    expect(out).toBe(`intro\n\n${receipt}\n\noutro`);
    expect(out.split(RISK_RECEIPT_START)).toHaveLength(2);
    expect(upsertRiskReceipt(out, receipt)).toBe(out);
  });

  it('collapses two pre-existing blocks into one', () => {
    const out = upsertRiskReceipt(`a\n\n${old}\n\nb\n\n${old}\n\nc`, receipt);
    expect(out).toBe(`a\n\n${receipt}\n\nb\n\nc`);
  });

  it('replaces an unterminated block through the end of the body', () => {
    expect(upsertRiskReceipt(`intro\n\n${RISK_RECEIPT_START}\nhalf`, receipt)).toBe(`intro\n\n${receipt}`);
  });
});

function fakeOctokit(body: string | null, filenames: string[]) {
  const listFiles = vi.fn(async () => ({ data: filenames.map((filename) => ({ filename })) }));
  const get = vi.fn(async () => ({ data: { body } }));
  const update = vi.fn(async (_args: { body: string; pull_number: number }) => ({}));
  const octokit = { rest: { pulls: { listFiles, get, update } } } as never;
  return { octokit, listFiles, get, update };
}

describe('publishRiskReceipt', () => {
  it('regenerates a path-free receipt for a mixed diff', async () => {
    const paths = ['src/widget.test.ts', 'scripts/build.sh', 'src/widget.ts'];
    const legacy = `${RISK_RECEIPT_START}\n${paths.join(' ')}\n${RISK_RECEIPT_END}`;
    const f = fakeOctokit(`intro\n${legacy}\noutro`, paths);
    const result = await publishRiskReceipt({ octokit: f.octokit, owner: 'o', repo: 'r', prNumber: 5 });
    const body = f.update.mock.calls[0][0].body;
    expect(body).toContain(renderRiskReceipt(result.evaluation));
    expect(body).toContain(`**Tier: ${result.evaluation.tier}**`);
    for (const rule of result.evaluation.rules) expect(body).toContain(`\`${rule.id}\``);
    for (const path of paths) expect(body).not.toContain(path);
  });

  it('writes a receipt with the tier into the PR body', async () => {
    const f = fakeOctokit('Closes #5', ['src/auth/login.ts']);
    const res = await publishRiskReceipt({ octokit: f.octokit, owner: 'o', repo: 'r', prNumber: 5 });
    expect(f.update).toHaveBeenCalledTimes(1);
    const arg = f.update.mock.calls[0];
    expect(arg[0].pull_number).toBe(5);
    expect(arg[0].body).toContain('Closes #5');
    expect(arg[0].body).toContain('**Tier: high**');
    expect(arg[0].body).toContain('`auth`');
    expect(res.updated).toBe(true);
    expect(res.evaluation.tier).toBe('high');
  });

  it('does not write again when the body already holds this receipt', async () => {
    const first = fakeOctokit('Closes #5', ['src/auth/login.ts']);
    await publishRiskReceipt({ octokit: first.octokit, owner: 'o', repo: 'r', prNumber: 5 });
    const written = first.update.mock.calls[0][0].body;
    const second = fakeOctokit(written, ['src/auth/login.ts']);
    const res = await publishRiskReceipt({ octokit: second.octokit, owner: 'o', repo: 'r', prNumber: 5 });
    expect(second.update).not.toHaveBeenCalled();
    expect(res.updated).toBe(false);
  });

  it('forwards the rules option', async () => {
    const f = fakeOctokit('x', ['src/auth/login.ts']);
    const rules: RiskRuleSet = { rules: [{ id: 'all', tier: 'low', globs: ['**'] }] };
    const res = await publishRiskReceipt({ octokit: f.octokit, owner: 'o', repo: 'r', prNumber: 5, rules });
    expect(res.evaluation.tier).toBe('low');
  });

  it('propagates a listFiles rejection', async () => {
    const f = fakeOctokit('x', []);
    f.listFiles.mockRejectedValueOnce(new Error('nope'));
    await expect(publishRiskReceipt({ octokit: f.octokit, owner: 'o', repo: 'r', prNumber: 5 })).rejects.toThrow(
      'nope',
    );
  });
});

describe('loadRiskPolicy / formatRiskPolicy', () => {
  const tmp = createTempDirs();
  const repoWith = (files: Record<string, string> = {}): string => {
    const root = tmp.makeSync('risk-policy-');
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(root, '.factory'), { recursive: true });
      writeFileSync(join(root, '.factory', name), text);
    }
    return root;
  };
  const yamlRules =
    'version: 2\nrisk:\n  rules:\n    - id: a\n      tier: high\n      globs: ["a/**"]\n    - id: b\n      tier: low\n      globs: ["b/**"]\n';
  const jsonRules = JSON.stringify({
    version: 2,
    risk: {
      rules: [
        { id: 'a', tier: 'high', globs: ['a/**'] },
        { id: 'b', tier: 'low', globs: ['b/**'] },
      ],
      refactorAllowlist: ['x/**'],
    },
  });

  it('returns the packaged defaults when the config file is absent', () => {
    expect(loadRiskPolicy(repoWith())).toEqual({
      source: 'default',
      file: '.factory/config.yaml',
      rules: DEFAULT_RISK_RULES,
    });
  });

  it('returns the packaged defaults when the config file has no risk section', () => {
    const policy = loadRiskPolicy(repoWith({ 'config.json': '{"version": 2}' }));
    expect(policy).toEqual({ source: 'default', file: '.factory/config.json', rules: DEFAULT_RISK_RULES });
    expect(loadRiskPolicy(repoWith({ 'config.yaml': '' })).source).toBe('default');
  });

  it('loads the risk section of config.yaml', () => {
    const policy = loadRiskPolicy(repoWith({ 'config.yaml': yamlRules }));
    expect(policy.source).toBe('repo');
    expect(policy.file).toBe('.factory/config.yaml');
    expect(policy.rules.rules.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('loads the risk section of config.json, refactor allowlist included', () => {
    const policy = loadRiskPolicy(repoWith({ 'config.json': jsonRules }));
    expect(policy.source).toBe('repo');
    expect(policy.file).toBe('.factory/config.json');
    expect(policy.rules.refactorAllowlist).toEqual(['x/**']);
  });

  it('throws a RiskRulesError naming the file and the risk key for an invalid section', () => {
    const badTier = 'risk:\n  rules:\n    - id: a\n      tier: huge\n      globs: ["a/**"]\n';
    const run = () => loadRiskPolicy(repoWith({ 'config.yaml': badTier }));
    expect(run).toThrow(RiskRulesError);
    expect(run).toThrow('invalid `risk` section in .factory/config.yaml: invalid risk rule "a" (rules[0]): tier');
    expect(() => loadRiskPolicy(repoWith({ 'config.json': '{"risk": null}' }))).toThrow(
      'invalid `risk` section in .factory/config.json: invalid risk rules',
    );
  });

  it('propagates a malformed config file error', () => {
    expect(() => loadRiskPolicy(repoWith({ 'config.yaml': 'risk: [\n' }))).toThrow('config.yaml');
  });

  it('formats the default summary with rule ids per tier', () => {
    const lines = formatRiskPolicy({ source: 'default', file: '.factory/config.yaml', rules: DEFAULT_RISK_RULES });
    expect(lines[0]).toBe(
      'no risk policy configured (no `risk` section in .factory/config.yaml); using the packaged defaults (13 rules)',
    );
    expect(lines[1]).toMatch(/^high: migrations-schema, auth/);
  });

  it('formats a repo summary without empty tiers', () => {
    const lines = formatRiskPolicy(loadRiskPolicy(repoWith({ 'config.yaml': yamlRules })));
    expect(lines).toEqual(['.factory/config.yaml `risk` (2 rules)', 'high: a', 'low: b']);
  });

  it('adds the refactor allowlist only when set and uses the singular rule', () => {
    const rules = { rules: [{ id: 'a', tier: 'med' as const, globs: ['a/**'] }], refactorAllowlist: ['x/**', 'y/**'] };
    expect(formatRiskPolicy({ source: 'repo', file: '.factory/config.json', rules })).toEqual([
      '.factory/config.json `risk` (1 rule)',
      'med: a',
      'refactor allowlist: x/**, y/**',
    ]);
  });
});

describe('riskPolicyConfigFile', () => {
  const tmp = createTempDirs();

  it('is repo-relative under the repo and absolute for an outside state root', () => {
    const root = tmp.makeSync('risk-file-');
    expect(riskPolicyConfigFile(root)).toBe('.factory/config.yaml');
    const stateRoot = tmp.makeSync('risk-state-');
    vi.stubEnv('FACTORY_STATE_ROOT', stateRoot);
    try {
      expect(riskPolicyConfigFile(root)).toBe(join(stateRoot, 'config.yaml'));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
