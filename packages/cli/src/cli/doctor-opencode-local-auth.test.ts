import { describe, expect, it } from 'vitest';

import { type DoctorEnvProbes, harnessSignInChecks } from './doctor.js';

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: () => false,
    tryExec: (cmd: string) => (cmd.includes('codex login status') ? 'Logged in using ChatGPT' : ''),
    pathExists: () => true,
    platform: 'darwin',
    claudeLoggedIn: () => true,
    opencodeLoggedIn: () => true,
    ...overrides,
  };
}

describe('opencode signed in row and local_auth failures (#2890)', () => {
  it('fails the opencode row when its last run hit local_auth with no login since', () => {
    const checks = harnessSignInChecks(
      probes({
        localAuthFailure: (a) => (a === 'opencode' ? { agent: a, at: '2026-10-13T16:00:00.000Z' } : null),
      }),
    );
    const row = checks.find((c) => c.name === 'opencode signed in');
    expect(row).toMatchObject({ ok: false, next: 'opencode auth login' });
    expect(row!.detail).toContain('2026-10-13T16:00:00.000Z');
    expect(row!.detail).toContain('opencode auth login');
    expect(checks.find((c) => c.name === 'claude signed in')).toMatchObject({ ok: true });
  });

  it('keeps the opencode row ok with no failure, or when the probe throws', () => {
    const none = harnessSignInChecks(probes({ localAuthFailure: () => null }));
    expect(none.find((c) => c.name === 'opencode signed in')).toMatchObject({ ok: true });
    const throwing = harnessSignInChecks(
      probes({
        localAuthFailure: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(throwing.find((c) => c.name === 'opencode signed in')).toMatchObject({ ok: true });
  });

  it('an opencode-only failure leaves the claude and codex rows identical to the no-failure baseline', () => {
    const baseline = harnessSignInChecks(probes({ localAuthFailure: () => null }));
    const failed = harnessSignInChecks(
      probes({
        localAuthFailure: (a) => (a === 'opencode' ? { agent: a, at: '2026-10-13T16:00:00.000Z' } : null),
      }),
    );
    for (const name of ['claude signed in', 'codex signed in']) {
      expect(failed.find((c) => c.name === name)).toEqual(baseline.find((c) => c.name === name));
    }
  });
});
