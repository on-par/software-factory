import { describe, expect, it } from 'vitest';

import {
  type DoctorEnvProbes,
  doctorFailed,
  harnessSignInChecks,
  reconcileAgentAuthChecks,
  runDoctorChecks,
} from './doctor.js';

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: () => true,
    tryExec: () => '',
    pathExists: () => true,
    platform: 'darwin',
    claudeLoggedIn: () => true,
    opencodeLoggedIn: () => true,
    ...overrides,
  };
}

describe('pi sign-in (#2903)', () => {
  it('is ok when a provider key is set', () => {
    const checks = harnessSignInChecks(probes({ envPresent: (k) => k === 'OPENROUTER_API_KEY' }));
    expect(checks.find((c) => c.name === 'pi signed in')).toMatchObject({
      ok: true,
      detail: 'signed in (OPENROUTER_API_KEY set)',
    });
  });

  it('is unverified with next: pi when no key is set', () => {
    const checks = harnessSignInChecks(probes({ envPresent: () => false }));
    const row = checks.find((c) => c.name === 'pi signed in')!;
    expect(row).toMatchObject({ ok: false, next: 'pi' });
    expect(row.detail).toContain('OPENROUTER_API_KEY');
    expect(row.fix).toContain('/login');
  });

  it('the missing coding-agent detail names pi', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: () => false }));
    expect(checks.find((c) => c.name === 'coding agent')!.detail).toContain('pi');
  });
});

describe('unusable codex session with pi installed (#2509, #2903)', () => {
  it('an unusable codex session plus a logged-out claude fails doctor', () => {
    const checks = reconcileAgentAuthChecks([
      ...runDoctorChecks(
        probes({
          codexSessionState: () => 'unusable',
          claudeLoggedIn: () => false,
          opencodeLoggedIn: () => false,
          envPresent: () => false,
        }),
      ),
      { name: 'claude auth (host)', ok: false, detail: 'claude -p failed on the host' },
    ]);
    expect(checks.find((c) => c.name === 'codex signed in')).toMatchObject({ ok: false, optional: false });
    expect(doctorFailed(checks)).toBe(true);
  });
});
