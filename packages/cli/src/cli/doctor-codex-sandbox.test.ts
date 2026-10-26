import { describe, expect, it } from 'vitest';

import { type DoctorEnvProbes, doctorFailed, runDoctorChecks } from './doctor.js';

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: () => false,
    pathExists: () => true,
    tryExec: (cmd: string) => {
      if (cmd.includes('git rev-parse')) return '/repo';
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git config user.name')) return 'Test User';
      if (cmd.includes('git config user.email')) return 'test@example.com';
      if (cmd.includes('gh auth token')) return 'gho_token';
      if (cmd.includes('gh auth status')) return 'Logged in';
      return '';
    },
    ...overrides,
  };
}

const noFirejail = (c: string): boolean => c !== 'firejail';
const codexDetail = (p: DoctorEnvProbes): string =>
  runDoctorChecks(p).find((c) => c.name === 'codex installed')!.detail;

describe('codex installed sandbox note (#3082)', () => {
  it('no sandbox runtime reports the codex preflight result and mode', () => {
    const checks = runDoctorChecks(probes({ platform: 'linux', commandAvailable: noFirejail }));
    const runtime = checks.find((c) => c.name === 'sandbox runtime')!;
    expect(runtime.ok).toBe(false);
    expect(runtime.optional).toBe(true);
    expect(runtime.detail).toContain('uncontained');
    expect(runtime.fix).toContain('firejail');
    const codex = checks.find((c) => c.name === 'codex installed')!;
    expect(codex.detail).toContain('preflight: no OS sandbox runtime (sandbox-exec/firejail) on PATH');
    expect(codex.detail).toContain('codex will use --sandbox workspace-write');
    expect(codex.detail).toContain(
      'to opt in to full access, list tasks under sandbox.codexFullAccessTasks in .factory/config.yaml',
    );
    expect(codex.detail).not.toContain('danger-full-access for');
    expect(codex.detail).not.toContain('sandboxed builds available');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('no sandbox runtime names the codex tasks opted in to full access', () => {
    const detail = codexDetail(
      probes({
        platform: 'linux',
        commandAvailable: noFirejail,
        codexFullAccessTasks: () => ['build_codex', '', 'build_codex'],
      }),
    );
    expect(detail).toContain('--sandbox danger-full-access for build_codex;');
    expect(detail.split('build_codex')).toHaveLength(2);
  });

  it('a throwing full-access probe falls back to no tasks', () => {
    const detail = codexDetail(
      probes({
        platform: 'linux',
        commandAvailable: noFirejail,
        codexFullAccessTasks: () => {
          throw new Error('bad config');
        },
      }),
    );
    expect(detail).not.toContain('danger-full-access for');
  });

  it('a sandbox runtime keeps the sandboxed-builds note without a preflight', () => {
    const detail = codexDetail(probes({ platform: 'linux', codexFullAccessTasks: () => ['build_codex'] }));
    expect(detail).toContain('sandboxed builds available');
    expect(detail).not.toContain('preflight:');
  });
});
