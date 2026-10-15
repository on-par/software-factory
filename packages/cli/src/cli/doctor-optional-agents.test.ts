import { describe, expect, it } from 'vitest';

import {
  type DoctorCheck,
  type DoctorEnvProbes,
  formatDoctorChecks,
  reconcileAgentAuthChecks,
  runDoctorChecks,
} from './doctor.js';
import { notInstalledDetail } from './doctor-harness.js';

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

const lineOf = (output: string, name: string) => output.split('\n').find((l) => l.includes(name)) ?? '';

describe('claude-only host: missing agents are optional info (#2996)', () => {
  it('shows codex, opencode and pi as ➖ and counts no warnings for them', () => {
    const final = reconcileAgentAuthChecks(
      runDoctorChecks(probes({ commandAvailable: without('codex', 'opencode', 'pi') })),
    );
    const output = formatDoctorChecks(final);
    for (const name of ['codex installed', 'opencode installed', 'pi installed']) {
      const line = lineOf(output, name);
      expect(line).toContain(`➖ ${name}`);
      expect(line).not.toContain('⚠️');
    }
    const warned = output.split('\n').filter((l) => l.includes('⚠️'));
    expect(Number(/(\d+) warnings/.exec(output)![1])).toBe(warned.length);
    for (const line of warned) expect(line).not.toMatch(/codex|opencode|\bpi\b/);
  });
});

describe('codex-only host: optional claude agent (#2551)', () => {
  it('shows claude, opencode and pi installed rows as ➖, not warnings (#2996)', () => {
    const final = reconcileAgentAuthChecks(
      runDoctorChecks(probes({ commandAvailable: without('claude', 'opencode', 'pi') })),
    );
    const output = formatDoctorChecks(final);
    for (const name of ['claude installed', 'opencode installed', 'pi installed'])
      expect(lineOf(output, name)).toContain(`➖ ${name}`);
    for (const line of output.split('\n').filter((l) => l.includes('⚠️')))
      expect(line).not.toMatch(/claude installed|opencode installed|pi installed/);
  });
});

describe('reconcileAgentAuthChecks skips missing agents (#2996)', () => {
  const claudeFailed: DoctorCheck = { name: 'claude auth (host)', ok: false, detail: 'claude -p failed on the host' };
  const codexOk: DoctorCheck = { name: 'codex signed in', ok: true, detail: 'logged in with ChatGPT' };
  const codexMissing: DoctorCheck = {
    name: 'codex installed',
    ok: false,
    optional: true,
    detail: notInstalledDetail('codex'),
    fix: 'install codex',
  };

  it('keeps a not-installed agent row a warning when no agent is signed in', () => {
    expect(reconcileAgentAuthChecks([codexMissing, claudeFailed])[0]).toBe(codexMissing);
  });

  it('skips a not-installed agent row while another agent is signed in', () => {
    const out = reconcileAgentAuthChecks([codexMissing, { name: 'claude signed in', ok: true, detail: 'ok' }]);
    expect(out[0]).toMatchObject({ ok: true, optional: true });
    expect(out[0]!.detail).toMatch(/^skipped: /);
    expect(out[0]).not.toHaveProperty('fix');
  });

  it('never rewrites an installed agent row that is not ok for another reason', () => {
    const badVersion: DoctorCheck = {
      name: 'opencode installed',
      ok: false,
      optional: true,
      detail: 'opencode 0.1 unsupported',
    };
    expect(reconcileAgentAuthChecks([badVersion, codexOk])[0]).toBe(badVersion);
  });

  it('leaves a passing codex installed row and an empty list alone', () => {
    const sandbox: DoctorCheck = { name: 'codex installed', ok: true, optional: true, detail: 'found' };
    expect(reconcileAgentAuthChecks([sandbox, codexOk])[0]).toBe(sandbox);
    expect(reconcileAgentAuthChecks([])).toEqual([]);
  });
});

describe('one row per agent (#2997)', () => {
  const mentionsCodex = (checks: DoctorCheck[]) =>
    checks.filter((c) => /\bcodex\b/i.test(`${c.name} ${c.detail} ${c.fix ?? ''}`));

  it('mentions codex in exactly one row when codex is not installed', () => {
    const raw = runDoctorChecks(probes({ commandAvailable: without('codex') }));
    for (const checks of [raw, reconcileAgentAuthChecks(raw)]) {
      const rows = mentionsCodex(checks);
      expect(rows.map((c) => c.name)).toEqual(['codex installed']);
    }
  });

  it('shows each installed agent (claude, codex, opencode) in exactly one agent row', () => {
    const checks = runDoctorChecks(probes());
    for (const cli of ['claude', 'codex', 'opencode']) {
      const rows = checks.filter(
        (c) =>
          c.name.startsWith(`${cli} `) &&
          !c.name.endsWith(' signed in') &&
          !c.name.includes('auth') &&
          c.name !== 'claude keychain (macOS)',
      );
      expect(rows.map((c) => c.name)).toEqual([`${cli} installed`]);
    }
  });
});
