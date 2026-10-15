import { describe, expect, it } from 'vitest';

import {
  type DoctorCheck,
  type DoctorEnvProbes,
  formatDoctorChecks,
  readyAgents,
  reconcileAgentAuthChecks,
  runDoctorChecks,
} from './doctor.js';

const SIGN_IN_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENCODE_API_KEY']);

const without =
  (...gone: string[]) =>
  (cmd: string) =>
    !gone.includes(cmd);

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: (key) => !SIGN_IN_ENV_KEYS.has(key),
    tryExec: (cmd: string) => {
      if (cmd.includes('git rev-parse')) return '/repo';
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git config user.name')) return 'Test User';
      if (cmd.includes('git config user.email')) return 'test@example.com';
      if (cmd.includes('gh auth token')) return 'gho_token';
      if (cmd.includes('gh auth status')) return 'Logged in';
      if (cmd.includes('codex login status')) return 'Logged in using ChatGPT';
      if (cmd.includes('git remote get-url origin')) return 'https://github.com/o/r.git';
      return '';
    },
    pathExists: () => true,
    platform: 'darwin',
    claudeLoggedIn: () => true,
    opencodeLoggedIn: () => true,
    ...overrides,
  };
}

describe('doctor-summary-ready-agents', () => {
  const summaryLine = (checks: DoctorCheck[]) =>
    formatDoctorChecks(checks)
      .split('\n')
      .find((l) => /\d+ passed, \d+ failed, \d+ warnings/.test(l));

  it('summary says ready: claude with a claude-only shim', () => {
    const checks = reconcileAgentAuthChecks(
      runDoctorChecks(probes({ commandAvailable: without('codex', 'opencode', 'pi') })),
    );
    expect(summaryLine(checks)).toMatch(/; ready: claude$/);
    expect(summaryLine(checks)).not.toContain('codex');
    expect(readyAgents(checks)).toEqual(['claude']);
  });

  it('summary names claude and codex when both are signed in', () => {
    const checks = reconcileAgentAuthChecks(runDoctorChecks(probes({ commandAvailable: without('opencode', 'pi') })));
    expect(summaryLine(checks)).toMatch(/; ready: claude, codex$/);
  });

  it('omits ready when no agent is signed in', () => {
    expect(summaryLine([{ name: 'claude signed in', ok: false, detail: 'unverified' }])).toBe(
      '0 passed, 1 failed, 0 warnings',
    );
  });

  it('ignores an optional ok sign-in row', () => {
    expect(readyAgents([{ name: 'codex signed in', ok: true, optional: true, detail: 'skipped' }])).toEqual([]);
  });
});
