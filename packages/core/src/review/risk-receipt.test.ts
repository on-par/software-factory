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
  it('lists every matched rule with its tier and paths', () => {
    const out = renderRiskReceipt(evaluation);
    expect(out.startsWith(RISK_RECEIPT_START)).toBe(true);
    expect(out.endsWith(RISK_RECEIPT_END)).toBe(true);
    expect(out).toContain('**Tier: high**');
    expect(out).toContain('| `auth` | high | `src/auth/login.ts`, `src/auth/session.ts` |');
    expect(out).toContain('| `docs` | low | `README.md` |');
  });

  it('truncates long path lists, shows (none), and escapes pipes', () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${i}.md`);
    const out = renderRiskReceipt({
      tier: 'med',
      rules: [
        { id: 'docs', tier: 'low', paths: many },
        { id: 'empty-diff', tier: 'med', paths: [] },
        { id: 'odd', tier: 'low', paths: ['a|b`c.ts'] },
      ],
    });
    expect(out).toContain('`f9.md`, … and 2 more |');
    expect(out).not.toContain('f10.md');
    expect(out).toContain('| `empty-diff` | med | (none) |');
    expect(out).toContain('`a\\|bc.ts`');
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
  const repoWith = (text?: string): string => {
    const root = tmp.makeSync('risk-policy-');
    if (text !== undefined) {
      mkdirSync(join(root, '.factory'), { recursive: true });
      writeFileSync(join(root, '.factory', 'risk.yml'), text);
    }
    return root;
  };
  const twoRules =
    'rules:\n  - id: a\n    tier: high\n    globs: ["a/**"]\n  - id: b\n    tier: low\n    globs: ["b/**"]\n';

  it('returns the packaged defaults when the file is absent', () => {
    expect(loadRiskPolicy(repoWith())).toEqual({ source: 'default', rules: DEFAULT_RISK_RULES });
  });

  it('loads a valid repo policy', () => {
    const policy = loadRiskPolicy(repoWith(twoRules));
    expect(policy.source).toBe('repo');
    expect(policy.rules.rules.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('throws on an empty file, an invalid tier, and malformed YAML', () => {
    expect(() => loadRiskPolicy(repoWith(''))).toThrow();
    const badTier = 'rules:\n  - id: a\n    tier: huge\n    globs: ["a/**"]\n';
    expect(() => loadRiskPolicy(repoWith(badTier))).toThrow(RiskRulesError);
    expect(() => loadRiskPolicy(repoWith('rules: [\n'))).toThrow('risk.yml');
  });

  it('formats the default summary with rule ids per tier', () => {
    const lines = formatRiskPolicy({ source: 'default', rules: DEFAULT_RISK_RULES });
    expect(lines[0]).toBe(
      'no risk policy configured (.factory/risk.yml not found); using the packaged defaults (13 rules)',
    );
    expect(lines[1]).toMatch(/^high: migrations-schema, auth/);
  });

  it('formats a repo summary without empty tiers', () => {
    const lines = formatRiskPolicy(loadRiskPolicy(repoWith(twoRules)));
    expect(lines).toEqual(['.factory/risk.yml (2 rules)', 'high: a', 'low: b']);
  });

  it('adds the refactor allowlist only when set and uses the singular rule', () => {
    const rules = { rules: [{ id: 'a', tier: 'med' as const, globs: ['a/**'] }], refactorAllowlist: ['x/**', 'y/**'] };
    expect(formatRiskPolicy({ source: 'repo', rules })).toEqual([
      '.factory/risk.yml (1 rule)',
      'med: a',
      'refactor allowlist: x/**, y/**',
    ]);
  });
});
