import { describe, expect, it } from 'vitest';

import {
  type DoctorEnvProbes,
  doctorFailed,
  formatDoctorChecks,
  HARNESS_SETUP,
  reconcileAgentAuthChecks,
  runDoctorChecks,
} from './doctor.js';

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: () => false,
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

describe('doctor-no-agent-fails-with-hints', () => {
  it('reports every missing agent as a failure with an install hint on an empty PATH', () => {
    const checks = reconcileAgentAuthChecks(runDoctorChecks(probes({ commandAvailable: () => false })));
    for (const { cli, install } of HARNESS_SETUP) {
      const row = checks.find((c) => c.name === `${cli} installed`);
      expect(row?.ok).toBe(false);
      expect(row?.optional).toBe(false);
      expect(row?.fix).toMatch(/^install /);
      expect(row?.fix).toContain(install);
    }
    expect(doctorFailed(checks)).toBe(true);
    const output = formatDoctorChecks(checks);
    const lines = output.split('\n');
    for (const { cli } of HARNESS_SETUP) {
      const i = lines.findIndex((l) => l.includes(`❌ ${cli} installed`));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(lines[i + 1]).toContain('fix: install ');
    }
    expect(Number(/(\d+) failed/.exec(output)?.[1])).toBeGreaterThanOrEqual(5);
  });

  it('keeps missing agents non-failing when one agent is installed (#2551)', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'claude' }));
    expect(checks.find((c) => c.name === 'claude installed')?.optional).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });
});
