import { describe, expect, it } from 'vitest';

import { type DoctorEnvProbes, runDoctorChecks } from './doctor.js';

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
  it('no sandbox runtime names the codex tasks opted in to full access', () => {
    const detail = codexDetail(
      probes({
        platform: 'linux',
        commandAvailable: noFirejail,
        codexSandbox: () => 'workspace-write',
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
        codexSandbox: () => 'workspace-write',
        codexFullAccessTasks: () => {
          throw new Error('bad config');
        },
      }),
    );
    expect(detail).not.toContain('danger-full-access for');
  });

  it('a sandbox runtime keeps the sandboxed-builds note without a preflight', () => {
    const detail = codexDetail(
      probes({ platform: 'linux', codexSandbox: () => 'workspace-write', codexFullAccessTasks: () => ['build_codex'] }),
    );
    expect(detail).toContain('sandboxed builds available');
    expect(detail).not.toContain('preflight:');
  });

  it('unset mode says codex runs without its own sandbox and names the workspace-write opt-in', () => {
    const none = codexDetail(probes({ platform: 'linux', commandAvailable: noFirejail }));
    expect(none).toContain('codex runs without its own sandbox (--sandbox danger-full-access) by default');
    expect(none).toContain('set sandbox.codexSandbox: workspace-write');
    expect(none).not.toContain('codex will use --sandbox workspace-write');
    const withRuntime = codexDetail(probes({ platform: 'linux', codexSandbox: () => undefined }));
    expect(withRuntime).toContain('sandboxed builds available; codex runs without its own sandbox');
  });

  it('workspace-write mode keeps the workspace-write preflight note', () => {
    const detail = codexDetail(
      probes({ platform: 'linux', commandAvailable: noFirejail, codexSandbox: () => 'workspace-write' }),
    );
    expect(detail).toContain('codex will use --sandbox workspace-write');
    expect(detail).toContain('to opt in to full access, list tasks under sandbox.codexFullAccessTasks');
  });

  it('a throwing codexSandbox probe falls back to the default note', () => {
    const detail = codexDetail(
      probes({
        platform: 'linux',
        commandAvailable: noFirejail,
        codexSandbox: () => {
          throw new Error('bad config');
        },
      }),
    );
    expect(detail).toContain('by default');
  });
});
