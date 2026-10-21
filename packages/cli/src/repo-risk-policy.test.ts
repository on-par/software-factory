// packages/cli/src/repo-risk-policy.test.ts — the committed software-factory risk policy (#3388)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRisk, loadRiskPolicy, RISK_POLICY_FILE } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Checked in a scratch repo holding only the committed .gitignore, so a machine-local
// .git/info/exclude (the factory adds `.factory/` there) cannot mask the repo's own rules.
const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

const gitIgnoreStatus = (path: string): number => {
  const dir = tmp.makeSync('risk-gitignore-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    copyFileSync(join(repoRoot, '.gitignore'), join(dir, '.gitignore'));
    execFileSync('git', ['check-ignore', '-q', path], { cwd: dir, stdio: 'ignore' });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
};

const ADR =
  'docs/adr/0144-merges-follow-a-t0-t1-t2-trust-tier-ladder-where-t0-human-merge-is-the-default-and-sensitive-paths-or-classifier-errors-fail-closed-to-t0.md';

const table: [string, string, string][] = [
  ['.github/workflows/ci.yml', 'high', 'ci-gates'],
  ['scripts/verify.sh', 'high', 'ci-gates'],
  ['vitest.config.ts', 'high', 'ci-gates'],
  ['packages/core/src/run/ci-suppression-guard.ts', 'high', 'ci-gates'],
  ['packages/cli/src/cli/land.ts', 'high', 'merge-land'],
  ['packages/cli/src/cli/merge-scope.ts', 'high', 'merge-land'],
  ['packages/core/src/review/floor.ts', 'high', 'risk-review-policy'],
  ['.factory/risk.yml', 'high', 'risk-review-policy'],
  ['packages/core/src/sandbox/egress-proxy.ts', 'high', 'sandbox-egress'],
  ['packages/config/src/defaults.ts', 'high', 'model-routing'],
  ['package.json', 'high', 'dependencies'],
  ['packages/core/package.json', 'high', 'dependencies'],
  ['packages/cli/src/cli/doctor-git-auth-ssh.ts', 'high', 'secrets-auth'],
  ['AGENTS.md', 'high', 'agent-instructions'],
  ['packages/core/src/internal.ts', 'med', 'public-api'],
  ['scripts/adr-index.ts', 'med', 'build-release'],
  ['packages/core/src/queue/github-queue.ts', 'med', 'unmatched'],
  [ADR, 'low', 'docs'],
  ['packages/core/src/queue/github-queue.test.ts', 'low', 'tests-only'],
];

describe('committed .factory/risk.yml', () => {
  it('validates against the risk rules schema as the repo policy', () => {
    expect(existsSync(join(repoRoot, RISK_POLICY_FILE))).toBe(true);
    const policy = loadRiskPolicy(repoRoot);
    expect(policy.source).toBe('repo');
    expect(policy.rules.rules.length).toBeGreaterThan(0);
  });

  it('is tracked, not ignored by .gitignore', () => {
    expect(gitIgnoreStatus(RISK_POLICY_FILE)).toBe(1);
    expect(gitIgnoreStatus('.factory/state/run.json')).toBe(0);
  });

  it.each(table)('classifies %s as %s via %s', (path, tier, ruleId) => {
    const ev = evaluateRisk({ paths: [path], rules: loadRiskPolicy(repoRoot).rules });
    expect(ev.tier).toBe(tier);
    expect(ev.rules.map((r) => r.id)).toContain(ruleId);
  });

  it('reports the highest tier for a mixed change', () => {
    const ev = evaluateRisk({
      paths: ['docs/README.md', 'packages/cli/src/cli/land.ts'],
      rules: loadRiskPolicy(repoRoot).rules,
    });
    expect(ev.tier).toBe('high');
    expect(ev.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['merge-land', 'docs']));
  });
});
