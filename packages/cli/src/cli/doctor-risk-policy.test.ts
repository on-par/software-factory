// packages/cli/src/cli/doctor-risk-policy.test.ts — factory doctor shows the repo risk policy (#3387)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HARNESS_SETUP } from './doctor-harness.js';
import { h, installDoctorHarness, logged, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();

const writeConfig = (name: string, text: string): void => {
  mkdirSync(join(h.repoRoot, '.factory'), { recursive: true });
  writeFileSync(join(h.repoRoot, '.factory', name), text);
};

describe('factory doctor risk policy', () => {
  beforeEach(() => {
    const home = join(h.repoRoot, 'test-home');
    const dirs = {
      HOME: home,
      CODEX_HOME: join(h.repoRoot, 'no-codex-home'),
      CLAUDE_CONFIG_DIR: join(h.repoRoot, 'no-claude-config'),
      XDG_DATA_HOME: join(h.repoRoot, 'no-xdg-data'),
    };
    for (const [key, dir] of Object.entries(dirs)) {
      mkdirSync(dir, { recursive: true });
      vi.stubEnv(key, dir);
    }
    for (const key of new Set(HARNESS_SETUP.flatMap(({ envKeys }) => envKeys))) vi.stubEnv(key, '');
    writeFileSync(join(h.repoRoot, 'no-claude-config', '.credentials.json'), '{}');
    h.execSyncImpl = (cmd: string) => {
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('status --porcelain')) return '';
      if (cmd.includes('git config user.name')) return 'Test User';
      if (cmd.includes('git config user.email')) return 'test@example.com';
      if (cmd.includes('gh auth token')) return 'gho_token';
      if (cmd.includes('gh auth status')) return 'Logged in';
      return '';
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows the `risk` section of .factory/config.yaml with rule ids per tier', async () => {
    h.claudeAvailable = true;
    writeConfig(
      'config.yaml',
      [
        'version: 2',
        'risk:',
        '  rules:',
        '    - id: sf-auth',
        '      tier: high',
        "      globs: ['packages/**/auth/**']",
        '    - id: sf-docs',
        '      tier: low',
        "      globs: ['docs/**']",
      ].join('\n'),
    );
    await runMainWith(undefined, 'doctor');
    const out = logged();
    expect(out).toContain('risk policy');
    expect(out).toContain('.factory/config.yaml `risk` (2 rules)');
    expect(out).toContain('high: sf-auth');
    expect(out).toContain('low: sf-docs');
  });

  it('shows the `risk` section of .factory/config.json', async () => {
    h.claudeAvailable = true;
    writeConfig(
      'config.json',
      JSON.stringify({ version: 2, risk: { rules: [{ id: 'sf-docs', tier: 'low', globs: ['docs/**'] }] } }),
    );
    await runMainWith(undefined, 'doctor');
    expect(logged()).toContain('.factory/config.json `risk` (1 rule)');
  });

  it('states that no risk policy is configured when the config has no risk section', async () => {
    h.claudeAvailable = true;
    writeConfig('config.yaml', 'version: 2\n');
    await runMainWith(undefined, 'doctor');
    expect(logged()).toContain('no risk policy configured (no `risk` section in .factory/config.yaml)');
  });

  it('reports an invalid risk section on the risk row and as a config schema error with its line', async () => {
    h.claudeAvailable = true;
    writeConfig('config.yaml', 'version: 2\nrisk:\n  rules:\n    - id: a\n      tier: huge\n      globs: [a]\n');
    const res = await runMainWith(undefined, 'doctor');
    const out = logged();
    expect(out).toContain('risk policy - invalid `risk` section in .factory/config.yaml');
    expect(out).toContain("config - .factory/config.yaml:5: schema error at 'risk.rules.0.tier'");
    expect(res.exited).toBe(true);
  });
});
