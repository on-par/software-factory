// packages/cli/src/cli/doctor-risk-policy.test.ts — factory doctor shows the repo risk policy (#3387)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HARNESS_SETUP } from './doctor-harness.js';
import { h, installDoctorHarness, logged, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();

const writePolicy = (text: string): void => {
  mkdirSync(join(h.repoRoot, '.factory'), { recursive: true });
  writeFileSync(join(h.repoRoot, '.factory', 'risk.yml'), text);
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

  it('shows the configured .factory/risk.yml policy with rule ids per tier', async () => {
    h.claudeAvailable = true;
    writePolicy(
      [
        'rules:',
        '  - id: sf-auth',
        '    tier: high',
        "    globs: ['packages/**/auth/**']",
        '  - id: sf-docs',
        '    tier: low',
        "    globs: ['docs/**']",
      ].join('\n'),
    );
    await runMainWith(undefined, 'doctor');
    const out = logged();
    expect(out).toContain('risk policy');
    expect(out).toContain('.factory/risk.yml (2 rules)');
    expect(out).toContain('high: sf-auth');
    expect(out).toContain('low: sf-docs');
  });

  it('states that no risk policy is configured when .factory/risk.yml is absent', async () => {
    h.claudeAvailable = true;
    await runMainWith(undefined, 'doctor');
    expect(logged()).toContain('no risk policy configured');
  });

  it('reports an invalid .factory/risk.yml without failing the doctor exit code', async () => {
    h.claudeAvailable = true;
    writePolicy('');
    const res = await runMainWith(undefined, 'doctor');
    expect(logged()).toContain('invalid .factory/risk.yml');
    expect(res.exited).toBe(false);
  });
});
