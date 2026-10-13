import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConstitutionLoader } from '@on-par/factory-core';
import { type ConfigLintInput, lintFactoryConfig } from '@on-par/factory-core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  analyzeEventLog,
  configLintChecks,
  type ClaudeAuthProbeResult,
  claudeKeychainCheck,
  codexAuthMethod,
  type DoctorEnvProbes,
  declaredHarnessChecks,
  doctorCheckIcon,
  doctorFailed,
  eventLogCheck,
  formatContainerReconcileReport,
  formatDoctorChecks,
  formatClaimReconcileReport,
  formatMicroVmReconcileReport,
  formatReconcileReport,
  formatWorktreeReconcileReport,
  GIT_AUTH_FIX,
  GIT_AUTH_PROBE_CMD,
  GIT_AUTH_PROBE_TIMEOUT_MS,
  harnessInstallChecks,
  gitAuthCheck,
  type GreenPrScanResult,
  leaseChecks,
  modelsRegistryChecks,
  keychainPreflightError,
  type LeaseHealthRow,
  NOT_IN_REPO_HINT,
  NOT_IN_REPO_SKIP_DETAIL,
  orphanContainerChecks,
  orphanMicroVmChecks,
  type ReapRow,
  REPO_SECTION,
  runDoctorChecks,
  sandboxAuthSkipDetail,
  sandboxClaudeAuthChecks,
  unmergedGreenPrChecks,
  reconcileAgentAuthChecks,
} from './doctor.js';
import { PREREQUISITES_TEXT } from './index.js';

const SIGN_IN_ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENCODE_API_KEY'];

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: (key) => !SIGN_IN_ENV_KEYS.includes(key),
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

describe('gitAuthCheck', () => {
  it('outside a git repo, git auth is skipped with a reason and does not fail doctor', () => {
    const tryExecSpy = vi.fn((_cmd: string): string | null => 'https://github.com/o/r.git');
    const check = gitAuthCheck(null, tryExecSpy);
    expect(check).toMatchObject({ name: 'git auth', ok: true, optional: true });
    expect(check.detail).toMatch(/^skipped: not inside a git repository/);
    expect(check.detail).toContain(NOT_IN_REPO_HINT);
    expect(tryExecSpy.mock.calls.some(([cmd]) => cmd.includes('git remote'))).toBe(false);
    expect(tryExecSpy.mock.calls.some(([cmd]) => cmd.includes('ls-remote'))).toBe(false);

    const base = probes();
    const checks = runDoctorChecks(
      probes({ tryExec: (cmd) => (cmd.includes('git rev-parse') ? null : base.tryExec(cmd)) }),
    );
    const row = checks.find((c) => c.name === 'git auth')!;
    expect(row).toMatchObject({ ok: true, optional: true });
    expect(row.detail).toMatch(/^skipped: /);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('in a repo with no origin remote, git auth is skipped with a reason and does not fail doctor', () => {
    for (const result of [null, '']) {
      const spy = vi.fn((_cmd: string): string | null => result);
      expect(gitAuthCheck('/repo', spy)).toEqual({
        name: 'git auth',
        ok: true,
        optional: true,
        detail: 'skipped: no origin remote configured',
      });
      expect(spy.mock.calls.some(([cmd]) => cmd.includes('ls-remote'))).toBe(false);
    }

    const base = probes();
    const checks = runDoctorChecks(
      probes({ tryExec: (cmd) => (cmd.includes('git remote get-url origin') ? null : base.tryExec(cmd)) }),
    );
    const row = checks.find((c) => c.name === 'git auth')!;
    expect(row).toMatchObject({ ok: true, optional: true, detail: 'skipped: no origin remote configured' });
    expect(doctorFailed(checks)).toBe(false);
  });

  it('with an origin remote, git auth passes when the non-interactive ls-remote probe succeeds', () => {
    for (const probeOut of ['abc123\tHEAD', '']) {
      const check = gitAuthCheck('/repo', (cmd) =>
        cmd.includes('ls-remote') ? probeOut : 'https://user:tok@github.com/o/r.git',
      );
      expect(check).toMatchObject({ name: 'git auth', ok: true });
      expect(check.optional).toBeUndefined();
      expect(check.detail).not.toContain('tok');
      expect(check.detail).not.toContain('github.com');
    }
  });

  it('with an origin remote, git auth fails doctor when the ls-remote probe fails', () => {
    const check = gitAuthCheck('/repo', (cmd) =>
      cmd.includes('ls-remote') ? null : 'https://user:tok@github.com/o/r.git',
    );
    expect(check).toMatchObject({ name: 'git auth', ok: false });
    expect(check.optional).toBeUndefined();
    expect(check.detail).not.toContain('tok');
    expect(check.detail).not.toContain('github.com');
    expect(check.fix).toBe(GIT_AUTH_FIX);
    expect(check.fix).toContain('gh auth setup-git');
    expect(formatDoctorChecks([check])).toContain('fix: ' + GIT_AUTH_FIX);

    const base = probes();
    const checks = runDoctorChecks(
      probes({ tryExec: (cmd, opts) => (cmd.includes('ls-remote') ? null : base.tryExec(cmd, opts)) }),
    );
    expect(checks.find((c) => c.name === 'git auth')).toMatchObject({ ok: false });
    expect(doctorFailed(checks)).toBe(true);
  });

  it('shows the gh auth setup-git fix only on failure, never on pass or skip', () => {
    const passing = gitAuthCheck('/repo', (cmd) =>
      cmd.includes('ls-remote') ? 'abc\tHEAD' : 'https://github.com/o/r.git',
    );
    const notInRepo = gitAuthCheck(null, () => null);
    const noOrigin = gitAuthCheck('/repo', () => null);
    for (const check of [passing, notInRepo, noOrigin]) {
      expect(check.fix).toBeUndefined();
      expect(formatDoctorChecks([check])).not.toContain('gh auth setup-git');
    }
    const failing = gitAuthCheck('/repo', (cmd) => (cmd.includes('ls-remote') ? null : 'https://github.com/o/r.git'));
    expect(formatDoctorChecks([failing])).toContain('gh auth setup-git');
  });

  it('runs the probe with prompting disabled and a bounded timeout', () => {
    const spy = vi.fn((cmd: string, _opts?: unknown): string | null =>
      cmd.includes('get-url') ? 'https://github.com/o/r.git' : '',
    );
    gitAuthCheck('/repo', spy);
    const call = spy.mock.calls.find(([cmd]) => cmd.includes('ls-remote'))!;
    const opts = call[1] as { env: Record<string, string>; timeoutMs: number };
    expect(call[0]).toBe(GIT_AUTH_PROBE_CMD);
    expect(call[0]).toContain('credential.interactive=never');
    expect(call[0]).toContain('core.askPass=');
    expect(opts.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    });
    expect(opts.timeoutMs).toBe(GIT_AUTH_PROBE_TIMEOUT_MS);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(30_000);
  });
});

describe('runDoctorChecks', () => {
  it('fully configured repo: 17 checks all ok, pre-existing rows unchanged, doctorFailed false', () => {
    const checks = runDoctorChecks(probes());
    expect(checks).toHaveLength(17);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
    const byName = (n: string) => checks.find((c) => c.name === n)!;
    expect(byName('git repository').detail).toBe('/repo');
    expect(byName('git auth')).toMatchObject({ ok: true });
    expect(byName('git auth').detail).not.toContain('github.com');
    expect(byName('codex sandbox').detail).toBe('codex CLI found (sandboxed builds available)');
    expect(byName('git worktree clean').detail).toBe('clean');
    expect(byName('.factory initialized').detail).toBe('.factory/ present');
    expect(byName('git identity').detail).toBe('Test User <test@example.com>');
    expect(byName('sandbox runtime').detail).toBe('sandbox-exec found');
    for (const name of ['.factory initialized', 'git identity', 'git auth', 'git worktree clean']) {
      expect(byName(name).section).toBe(REPO_SECTION);
    }
  });

  it('claude CLI missing is optional when codex is installed and logged in (#1269)', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'claude' && cmd !== 'opencode' }));
    const claude = checks.find((c) => c.name === 'claude installed')!;
    expect(claude.ok).toBe(false);
    expect(claude.optional).toBe(true);
    expect(claude.section).toBe('Claude Code');
    expect(claude.fix).toMatch(/npm install -g @anthropic-ai\/claude-code$/);
    expect(checks.find((c) => c.name === 'coding agent')).toMatchObject({ ok: true, detail: 'found codex' });
    expect(checks.find((c) => c.name === 'codex signed in')).toMatchObject({ ok: true });
    expect(checks.find((c) => c.name === 'codex signed in')!.detail).toContain('ChatGPT');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('fails when no coding agent CLI is installed', () => {
    const agents = new Set(['claude', 'codex', 'opencode']);
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => !agents.has(cmd) }));
    const agent = checks.find((c) => c.name === 'coding agent')!;
    expect(agent.ok).toBe(false);
    expect(agent.fix).toContain('Codex CLI');
    expect(checks.find((c) => c.name === 'codex signed in')!.detail).toMatch(/^skipped/);
    expect(doctorFailed(checks)).toBe(true);
  });

  it('codex-only machine without a codex login fails codex auth with sign-in guidance (#2422)', () => {
    const base = probes();
    const checks = runDoctorChecks(
      probes({
        commandAvailable: (cmd) => cmd !== 'claude' && cmd !== 'opencode',
        tryExec: (cmd) => (cmd.includes('codex login status') ? 'Not logged in' : base.tryExec(cmd)),
      }),
    );
    const auth = checks.find((c) => c.name === 'codex signed in')!;
    expect(auth.ok).toBe(false);
    expect(auth.optional).toBe(false);
    expect(auth.fix).toMatch(/codex login$/);
    expect(auth.detail).toContain('--with-api-key');
    expect(auth.detail).toContain('--device-auth');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('an expired access token with a refresh token passes codex auth on a codex-only machine (#2509)', () => {
    const checks = runDoctorChecks(
      probes({
        commandAvailable: (cmd) => cmd !== 'claude' && cmd !== 'opencode',
        codexSessionState: () => 'refresh-pending',
      }),
    );
    const auth = checks.find((c) => c.name === 'codex signed in')!;
    expect(auth.ok).toBe(true);
    expect(auth.detail).toContain('refreshes it on the next run');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('an unusable ChatGPT session is not passing and names codex login (#2509)', () => {
    const checks = runDoctorChecks(
      probes({
        commandAvailable: (cmd) => cmd !== 'claude' && cmd !== 'opencode',
        codexSessionState: () => 'unusable',
      }),
    );
    const auth = checks.find((c) => c.name === 'codex signed in')!;
    expect(auth.ok).toBe(false);
    expect(auth.fix).toContain('codex login');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('an unusable codex session plus a logged-out claude fails doctor (#2509)', () => {
    const checks = reconcileAgentAuthChecks([
      ...runDoctorChecks(
        probes({ codexSessionState: () => 'unusable', claudeLoggedIn: () => false, opencodeLoggedIn: () => false }),
      ),
      { name: 'claude auth (host)', ok: false, detail: 'claude -p failed on the host' },
    ]);
    expect(checks.find((c) => c.name === 'codex signed in')).toMatchObject({ ok: false, optional: false });
    expect(doctorFailed(checks)).toBe(true);
  });

  it('a missing codex login is optional when another agent CLI is installed', () => {
    const base = probes();
    const checks = runDoctorChecks(
      probes({ tryExec: (cmd) => (cmd.includes('codex login status') ? null : base.tryExec(cmd)) }),
    );
    expect(checks.find((c) => c.name === 'codex signed in')).toMatchObject({ ok: false, optional: true });
  });

  it('codexAuthMethod maps status text to a fixed label and never echoes it', () => {
    expect(codexAuthMethod(null)).toBeNull();
    expect(codexAuthMethod('Not logged in')).toBeNull();
    expect(codexAuthMethod('Logged in using ChatGPT')).toBe('ChatGPT');
    expect(codexAuthMethod('Logged in using an API key - sk-abc***')).toBe('API key');
    expect(codexAuthMethod('Logged in using an access token')).toBe('access token');
    expect(codexAuthMethod('Logged in')).toBe('unknown method');
  });

  it('labels a non-ChatGPT login with its method', () => {
    const base = probes();
    const checks = runDoctorChecks(
      probes({
        tryExec: (cmd) => (cmd.includes('codex login status') ? 'Logged in using an API key' : base.tryExec(cmd)),
      }),
    );
    expect(checks.find((c) => c.name === 'codex signed in')!.detail).toBe('logged in with API key');
  });

  it('gh missing on PATH gives a distinct fail detail from gh unauthenticated', () => {
    const ghMissing = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'gh' }));
    const ghUnauth = runDoctorChecks(
      probes({
        tryExec: (cmd) => {
          if (cmd.includes('git rev-parse')) return '/repo';
          if (cmd.includes('git status --porcelain')) return '';
          if (cmd.includes('gh auth status')) return null;
          if (cmd.includes('gh auth token')) return 'gho_token';
          return '';
        },
      }),
    );

    const missingCheck = ghMissing.find((c) => c.name === 'gh auth')!;
    const unauthCheck = ghUnauth.find((c) => c.name === 'gh auth')!;
    expect(missingCheck.ok).toBe(false);
    expect(unauthCheck.ok).toBe(false);
    expect(missingCheck.detail).not.toBe(unauthCheck.detail);
    expect(missingCheck.detail).toBe('gh CLI not found on PATH');
    expect(unauthCheck.detail).toBe('gh is not authenticated');
  });

  it('falls back to gh auth token when no env token is set', () => {
    const checks = runDoctorChecks(probes({ envPresent: () => false }));
    const token = checks.find((c) => c.name === 'GitHub token')!;
    expect(token.ok).toBe(true);
    expect(token.detail).toBe('using gh auth token');
  });

  it('fails with the tokens-URL fix when no token source exists at all', () => {
    const checks = runDoctorChecks(
      probes({
        envPresent: () => false,
        tryExec: (cmd) => {
          if (cmd.includes('git rev-parse')) return '/repo';
          if (cmd.includes('git status --porcelain')) return '';
          if (cmd.includes('gh auth status')) return 'Logged in';
          if (cmd.includes('gh auth token')) return null;
          return '';
        },
      }),
    );
    const token = checks.find((c) => c.name === 'GitHub token')!;
    expect(token.ok).toBe(false);
    expect(token.detail).toBe('no GITHUB_TOKEN, GH_TOKEN, or gh auth token');
    expect(token.fix).toContain('create a token at https://github.com/settings/tokens');
  });

  it('outside a git repo, repo checks are skipped with the cd hint and doctorFailed is false', () => {
    const checks = runDoctorChecks(
      probes({
        tryExec: (cmd) => {
          if (cmd.includes('git rev-parse')) return null;
          if (cmd.includes('git config user.name')) return 'Test User';
          if (cmd.includes('git config user.email')) return 'test@example.com';
          if (cmd.includes('gh auth token')) return 'gho_token';
          if (cmd.includes('gh auth status')) return 'Logged in';
          return '';
        },
      }),
    );
    const git = checks.find((c) => c.name === 'git repository')!;
    const worktree = checks.find((c) => c.name === 'git worktree clean')!;
    const factoryInit = checks.find((c) => c.name === '.factory initialized')!;

    expect(git.ok).toBe(false);
    expect(git.optional).toBe(true);
    expect(git.fix).toBe(NOT_IN_REPO_HINT);
    expect(worktree.optional).toBe(true);
    expect(worktree.detail).toContain(NOT_IN_REPO_HINT);
    expect(factoryInit.optional).toBe(true);
    expect(factoryInit.detail).toContain(NOT_IN_REPO_HINT);
    expect(doctorFailed(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain('cd into your repo, then run factory doctor again');
  });

  it('git identity fails with the git config --global fix when user.email is unset', () => {
    const exec = (email: string | null, name: string | null) => (cmd: string) => {
      if (cmd.includes('git rev-parse')) return '/repo';
      if (cmd.includes('git config user.name')) return name;
      if (cmd.includes('git config user.email')) return email;
      return '';
    };
    const checks = runDoctorChecks(probes({ tryExec: exec(null, 'Test User') }));
    const identity = checks.find((c) => c.name === 'git identity')!;
    expect(identity.ok).toBe(false);
    expect(identity.optional).toBeUndefined();
    expect(identity.detail).toBe('user.email not set');
    expect(identity.next).toBe('git config --global user.email you@example.com');
    expect(identity.fix).toBeUndefined();
    expect(doctorFailed(checks)).toBe(true);

    const both = runDoctorChecks(probes({ tryExec: exec('', '') }));
    expect(both.find((c) => c.name === 'git identity')!.detail).toBe('user.name and user.email not set');
    expect(both.find((c) => c.name === 'git identity')!.next).toBe('git config --global user.name "Your Name"');
  });

  it('no sandbox runtime warns uncontained and codex says danger-full-access', () => {
    const checks = runDoctorChecks(probes({ platform: 'linux', commandAvailable: (c) => c !== 'firejail' }));
    const runtime = checks.find((c) => c.name === 'sandbox runtime')!;
    expect(runtime.ok).toBe(false);
    expect(runtime.optional).toBe(true);
    expect(runtime.detail).toContain('uncontained');
    expect(runtime.fix).toContain('firejail');
    const codex = checks.find((c) => c.name === 'codex sandbox')!;
    expect(codex.detail).toContain('danger-full-access');
    expect(codex.detail).not.toContain('sandboxed builds available');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('win32 has no sandbox runtime and warns', () => {
    const checks = runDoctorChecks(probes({ platform: 'win32' }));
    const runtime = checks.find((c) => c.name === 'sandbox runtime')!;
    expect(runtime.ok).toBe(false);
    expect(runtime.optional).toBe(true);
  });

  it('a dirty tree marks git worktree clean as an optional failure that does not fail doctor', () => {
    const checks = runDoctorChecks(
      probes({
        tryExec: (cmd) => {
          if (cmd.includes('git rev-parse')) return '/repo';
          if (cmd.includes('git status --porcelain')) return ' M file';
          if (cmd.includes('git config user.name')) return 'Test User';
          if (cmd.includes('git config user.email')) return 'test@example.com';
          if (cmd.includes('gh auth token')) return 'gho_token';
          if (cmd.includes('gh auth status')) return 'Logged in';
          return '';
        },
      }),
    );
    const worktree = checks.find((c) => c.name === 'git worktree clean')!;
    expect(worktree.ok).toBe(false);
    expect(worktree.optional).toBe(true);
    expect(worktree.detail).toBe('uncommitted changes present');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('.factory initialized fails with the init fix when the directory is missing in a real repo', () => {
    const checks = runDoctorChecks(probes({ pathExists: () => false }));
    const factoryInit = checks.find((c) => c.name === '.factory initialized')!;
    expect(factoryInit.ok).toBe(false);
    expect(factoryInit.optional).toBeUndefined();
    expect(factoryInit.detail).toBe('.factory/ missing');
    expect(factoryInit.next).toBe('factory init');
    expect(factoryInit.fix).toBeUndefined();
    expect(factoryInit.section).toBe(REPO_SECTION);
    expect(doctorFailed(checks)).toBe(true);
  });

  it('npm missing gives the Node.js >= 24 fix', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'npm' }));
    const npm = checks.find((c) => c.name === 'npm')!;
    expect(npm.ok).toBe(false);
    expect(npm.fix).toContain('Node.js >= 24');
    expect(npm.fix).not.toContain('20');
  });

  it('codex missing is an optional failure only', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'codex' }));
    const codex = checks.find((c) => c.name === 'codex sandbox')!;
    expect(codex.ok).toBe(false);
    expect(codex.optional).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });
});

describe('sandboxAuthSkipDetail', () => {
  it('names no sandbox runtime / not inside a git repository', () => {
    const noRuntime = 'skipped: no sandbox runtime (sandbox-exec/firejail) on this host';
    expect(sandboxAuthSkipDetail({ runtimeAvailable: false, hostOk: true, inRepo: true })).toBe(noRuntime);
    expect(sandboxAuthSkipDetail({ runtimeAvailable: false, hostOk: false, inRepo: false })).toBe(noRuntime);
    expect(sandboxAuthSkipDetail({ runtimeAvailable: true, hostOk: false, inRepo: true })).toBe(
      'skipped: host claude auth was not verified',
    );
    expect(sandboxAuthSkipDetail({ runtimeAvailable: true, hostOk: true, inRepo: false })).toBe(
      `skipped: not inside a git repository; ${NOT_IN_REPO_HINT}`,
    );
    expect(sandboxAuthSkipDetail({ runtimeAvailable: true, hostOk: true, inRepo: true })).toBeNull();
  });
});

describe('formatDoctorChecks', () => {
  it('matches the frozen format for a mixed pass/fail/warning set', () => {
    const checks = [
      { name: 'git repository', ok: true, detail: '/path/to/repo' },
      {
        name: 'claude CLI',
        ok: false,
        detail: 'not found on PATH',
        fix: 'install Claude Code first: https://docs.anthropic.com/en/docs/claude-code',
      },
      {
        name: 'codex sandbox',
        ok: false,
        optional: true,
        detail: 'codex CLI not found; codex build routes unavailable',
        fix: 'install the codex CLI, or rely on claude routes',
      },
    ];
    expect(formatDoctorChecks(checks)).toMatchInlineSnapshot(`
      "== factory doctor ==
        ✅ git repository - /path/to/repo
        ❌ claude CLI - not found on PATH
             fix: install Claude Code first: https://docs.anthropic.com/en/docs/claude-code
        ⚠️ codex sandbox - codex CLI not found; codex build routes unavailable
             fix: install the codex CLI, or rely on claude routes
      1 passed, 1 failed, 1 warnings

      Model reachability: factory models --doctor"
    `);
  });
});

describe('outside a git repo (#2554)', () => {
  function outsideProbes() {
    const base = probes();
    const tryExec = vi.fn((cmd: string): string | null => {
      if (cmd.includes('git rev-parse') || cmd.includes('git config user.')) return null;
      return base.tryExec(cmd);
    });
    return { tryExec, env: probes({ tryExec }) };
  }

  it('renders every repo check as skipped and does not fail when git identity is unset', () => {
    const { tryExec, env } = outsideProbes();
    const checks = runDoctorChecks(env);
    for (const name of ['git identity', 'git worktree clean', '.factory initialized', 'git auth']) {
      const row = checks.find((c) => c.name === name)!;
      expect(row.detail).toMatch(/^skipped: not inside a git repository/);
      expect(doctorCheckIcon(row)).toBe('➖');
    }
    const identity = checks.find((c) => c.name === 'git identity')!;
    expect(identity).toMatchObject({ ok: false, optional: true, detail: NOT_IN_REPO_SKIP_DETAIL });
    expect(identity.fix).toBeUndefined();
    expect(tryExec.mock.calls.some(([cmd]) => cmd.includes('git config user.'))).toBe(false);
    expect(doctorFailed(checks)).toBe(false);
    const out = formatDoctorChecks(checks, { inRepo: false });
    expect(out).toContain(' 0 failed');
    expect(out).not.toContain('❌');
  });

  it('prints no repo-bound next command', () => {
    const out = formatDoctorChecks(runDoctorChecks(outsideProbes().env), { inRepo: false });
    expect(out).not.toContain('factory models --doctor');
    expect(out).toContain('Model reachability: skipped: not inside a git repository');
    const fixes = out.split('\n').filter((l) => l.includes('fix:'));
    for (const line of fixes) expect(line).not.toMatch(/factory (models|init|run|queue|triage)\b/);
    expect(out.split('\n').filter((l) => l.includes('next:'))).toEqual([]);
  });

  it('keeps the in-repo trailer unchanged', () => {
    const rows = runDoctorChecks(probes());
    expect(formatDoctorChecks(rows).endsWith('Model reachability: factory models --doctor')).toBe(true);
    expect(formatDoctorChecks(rows, { inRepo: true }).endsWith('Model reachability: factory models --doctor')).toBe(
      true,
    );
  });
});

describe('repo checks (#2557)', () => {
  function rowBlocks(out: string): string[][] {
    const blocks: string[][] = [];
    for (const line of out.split('\n')) {
      if (/^ {2}\S+ /.test(line)) blocks.push([line]);
      else if (/^ {7}/.test(line) && blocks.length > 0) blocks[blocks.length - 1]!.push(line);
    }
    return blocks;
  }

  it('a repo without .factory fails the Repo section with next command factory init', () => {
    const checks = runDoctorChecks(probes({ pathExists: () => false }));
    const lines = formatDoctorChecks(checks, { inRepo: true }).split('\n');
    expect(lines).toContain('-- Repo --');
    const i = lines.findIndex((l) => l.includes('.factory initialized'));
    expect(lines[i]).toContain('❌');
    expect(lines[i + 1]).toBe('       next: factory init');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('gh unauthenticated or missing fails the gh auth row with next command gh auth login', () => {
    const base = probes();
    const cases = [
      probes({ commandAvailable: (c) => c !== 'gh' }),
      probes({ tryExec: (cmd) => (cmd.includes('gh auth status') ? null : base.tryExec(cmd)) }),
    ];
    for (const env of cases) {
      const checks = runDoctorChecks(env);
      const row = checks.find((c) => c.name === 'gh auth')!;
      expect(row.ok).toBe(false);
      expect(row.next).toBe('gh auth login');
      const block = rowBlocks(formatDoctorChecks(checks, { inRepo: true })).find((b) => b[0]!.includes('gh auth -'))!;
      expect(block.at(-1)).toBe('       next: gh auth login');
    }
  });

  it('every hard-failing row ends with exactly one next command', () => {
    const env = probes({
      commandAvailable: (c) => c === 'codex' || c === 'gh',
      envPresent: () => false,
      tryExec: (cmd) => {
        if (cmd.includes('git rev-parse')) return '/repo';
        if (cmd.includes('git config user.')) return null;
        if (cmd.includes('get-url origin')) return 'https://github.com/o/r.git';
        if (cmd.includes('codex login status')) return 'not logged in';
        if (cmd.includes('git status --porcelain')) return '';
        return null;
      },
      pathExists: () => false,
      distFreshness: () => ({ fresh: false, detail: 'stale' }),
    });
    const checks = runDoctorChecks(env);
    const hard = checks.filter((c) => !c.ok && !c.optional && c.name !== 'npm');
    expect(hard.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'git identity',
        'git auth',
        'gh auth',
        'GitHub token',
        '.factory initialized',
        'compiled dist fresh',
      ]),
    );
    const blocks = rowBlocks(formatDoctorChecks(checks, { inRepo: true }));
    for (const check of hard) {
      expect(check.next).toBeTruthy();
      expect(check.next).not.toMatch(/&&|;|\n/);
      const block = blocks.find((b) => b[0]!.includes(`${check.name} -`))!;
      expect(block.filter((l) => l.includes('next:'))).toHaveLength(1);
      expect(block.at(-1)).toBe(`       next: ${check.next}`);
    }
  });

  it('Repo section is shown only inside a git repo', () => {
    expect(formatDoctorChecks(runDoctorChecks(probes()), { inRepo: true })).toContain('-- Repo --');
    const base = probes();
    const outside = probes({
      tryExec: (cmd) => (cmd.includes('git rev-parse') || cmd.includes('git config user.') ? null : base.tryExec(cmd)),
    });
    const checks = runDoctorChecks(outside);
    expect(formatDoctorChecks(checks, { inRepo: false })).not.toContain('-- Repo --');
    expect(checks.some((c) => c.section === REPO_SECTION || c.next !== undefined)).toBe(false);
  });
});

describe('formatDoctorChecks icons', () => {
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  const rows = [
    { name: 'node', ok: true, detail: 'v22' },
    { name: 'sandbox runtime', ok: false, optional: true, detail: 'not available' },
    { name: 'codex sandbox', ok: false, optional: true, detail: 'codex CLI not found' },
    {
      name: 'git worktree clean',
      ok: false,
      optional: true,
      detail: `skipped: not a git repository; ${NOT_IN_REPO_HINT}`,
    },
    {
      name: '.factory initialized',
      ok: false,
      optional: true,
      detail: `skipped: not a git repository; ${NOT_IN_REPO_HINT}`,
    },
  ];
  const lineOf = (output: string, name: string) => output.split('\n').find((l) => l.includes(name)) ?? '';

  it('renders warnings with ⚠️ and skips with ➖, and no ❌ when 0 failed', () => {
    const output = formatDoctorChecks(rows);
    expect(count(output, '❌')).toBe(0);
    expect(count(output, '⚠️')).toBe(2);
    expect(count(output, '➖')).toBe(2);
    expect(output).toContain('0 failed, 4 warnings');
    for (const name of ['sandbox runtime', 'codex sandbox']) expect(lineOf(output, name)).toContain(`⚠️ ${name}`);
    for (const name of ['git worktree clean', '.factory initialized'])
      expect(lineOf(output, name)).toContain(`➖ ${name}`);
  });

  it('renders ❌ exactly once with 1 failed row alongside warnings and skips', () => {
    const output = formatDoctorChecks([...rows, { name: 'gh auth', ok: false, detail: 'not logged in' }]);
    expect(count(output, '❌')).toBe(1);
    expect(lineOf(output, '❌')).toContain('gh auth');
    expect(output).toContain('1 failed');
  });

  it('classifies single rows with doctorCheckIcon', () => {
    expect(doctorCheckIcon({ name: 'a', ok: true, detail: 'fine' })).toBe('✅');
    expect(doctorCheckIcon({ name: 'a', ok: true, optional: true, detail: 'skipped — no origin remote' })).toBe('➖');
    expect(doctorCheckIcon({ name: 'a', ok: false, detail: 'skipped — odd' })).toBe('❌');
    expect(doctorCheckIcon({ name: 'a', ok: false, optional: true, detail: '' })).toBe('⚠️');
  });

  it('keeps the ❌ count equal to the summary failed count outside a repo', () => {
    const output = formatDoctorChecks(runDoctorChecks(probes({ tryExec: () => null })));
    const failed = Number(/(\d+) failed/.exec(output)![1]);
    expect(count(output, '❌')).toBe(failed);
  });
});

describe('codex-only host: optional claude agent (#2551)', () => {
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  const lineOf = (output: string, name: string) => output.split('\n').find((l) => l.includes(name)) ?? '';

  function codexOnlyChecks(opts: { keychainDetail: string; runtimeAvailable: boolean }) {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'claude' && cmd !== 'opencode' }));
    checks.push(claudeKeychainCheck({ status: 'skipped', detail: opts.keychainDetail }));
    checks.push(
      ...sandboxClaudeAuthChecks({
        host: 'skipped',
        sandboxed: 'skipped',
        hostDetail: 'skipped — claude CLI not on PATH',
        sandboxDetail: sandboxAuthSkipDetail({ runtimeAvailable: opts.runtimeAvailable, hostOk: false, inRepo: true })!,
      }),
    );
    return reconcileAgentAuthChecks(checks);
  }

  const assertNoClaudeFailure = (final: ReturnType<typeof codexOnlyChecks>) => {
    const output = formatDoctorChecks(final);
    expect(lineOf(output, 'claude installed')).toMatch(/(⚠️|➖) claude installed/);
    for (const name of ['claude keychain (macOS)', 'claude auth (host)', 'claude auth (sandboxed)'])
      expect(lineOf(output, name)).toContain(`➖ ${name}`);
    for (const line of output.split('\n').filter((l) => l.includes('claude'))) expect(line).not.toContain('❌');
    expect(output).toContain('0 failed');
    expect(count(output, '❌')).toBe(0);
    expect(doctorFailed(final)).toBe(false);
  };

  it('codex-only host: claude rows never show ❌ and the summary says 0 failed', () => {
    assertNoClaudeFailure(
      codexOnlyChecks({ keychainDetail: 'skipped — claude CLI not on PATH', runtimeAvailable: true }),
    );
  });

  it('codex-only host without a sandbox runtime or macOS: claude rows never show ❌', () => {
    assertNoClaudeFailure(codexOnlyChecks({ keychainDetail: 'skipped — not macOS', runtimeAvailable: false }));
  });
});

describe('runDoctorChecks distFreshness probe', () => {
  it('includes a failing compiled dist fresh check when the probe reports stale, and fails doctor', () => {
    const checks = runDoctorChecks(probes({ distFreshness: () => ({ fresh: false, detail: 'core: stale' }) }));
    const distCheck = checks.find((c) => c.name === 'compiled dist fresh')!;
    expect(distCheck).toBeDefined();
    expect(distCheck.ok).toBe(false);
    expect(distCheck.optional).toBeUndefined();
    expect(distCheck.fix).toContain('npm run build');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('includes a passing compiled dist fresh check when the probe reports fresh', () => {
    const checks = runDoctorChecks(probes({ distFreshness: () => ({ fresh: true, detail: 'dist newer than src' }) }));
    const distCheck = checks.find((c) => c.name === 'compiled dist fresh')!;
    expect(distCheck).toBeDefined();
    expect(distCheck.ok).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('omits the compiled dist fresh check when the probe is not provided', () => {
    const checks = runDoctorChecks(probes());
    expect(checks.find((c) => c.name === 'compiled dist fresh')).toBeUndefined();
  });
});

describe('leaseChecks', () => {
  it('reports a single optional ok check when there are no leases', () => {
    const checks = leaseChecks([]);
    expect(checks).toEqual([{ name: 'port leases', ok: true, optional: true, detail: 'no active leases' }]);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('reports one check per row; stale rows fail without failing doctor overall', () => {
    const rows: LeaseHealthRow[] = [
      { worktreeId: '/wt/a', branch: 'a', port: 3100, pid: 111, alive: true },
      { worktreeId: '/wt/b', branch: 'b', port: 3101, pid: 222, alive: true },
      { worktreeId: '/wt/c', branch: 'c', port: 3102, pid: 333, alive: false, reason: 'dead-pid' },
    ];
    const checks = leaseChecks(rows);
    expect(checks).toHaveLength(3);

    const stale = checks.find((c) => c.name === 'port lease :3102')!;
    expect(stale.ok).toBe(false);
    expect(stale.optional).toBe(true);
    expect(stale.detail).toContain('/wt/c');
    expect(stale.detail).toContain('3102');
    expect(stale.detail).toContain('333');
    expect(stale.detail).toContain('dead-pid');
    expect(stale.fix).toContain('--reconcile');

    expect(doctorFailed([...runDoctorChecks(probes()), ...checks])).toBe(false);
  });

  it('mentions the port being squatted in the detail when portSquatted is true', () => {
    const rows: LeaseHealthRow[] = [
      {
        worktreeId: '/wt/c',
        branch: 'c',
        port: 3102,
        pid: 333,
        alive: false,
        reason: 'missing-worktree',
        portSquatted: true,
      },
    ];
    const stale = leaseChecks(rows)[0];
    expect(stale.detail).toContain('port still in use by another process');
  });
});

describe('analyzeEventLog', () => {
  it('reports 0 unparseable for clean NDJSON content', () => {
    const content = ['{"a":1}', '{"b":2}', '{"c":3}'].join('\n') + '\n';
    expect(analyzeEventLog(content)).toEqual({ total: 3, unparseable: 0 });
  });

  it('counts corrupt lines among total lines', () => {
    const content = ['{"a":1}', 'not json', '{"b":2}', '{"c":', '{"d":4}'].join('\n');
    expect(analyzeEventLog(content)).toEqual({ total: 5, unparseable: 2 });
  });

  it('reports 0 total for an empty string', () => {
    expect(analyzeEventLog('')).toEqual({ total: 0, unparseable: 0 });
  });

  it('ignores blank lines', () => {
    const content = '{"a":1}\n\n\n{"b":2}\n';
    expect(analyzeEventLog(content)).toEqual({ total: 2, unparseable: 0 });
  });
});

describe('eventLogCheck', () => {
  it('is ok when there is no events.ndjson yet', () => {
    const check = eventLogCheck(null);
    expect(check.ok).toBe(true);
    expect(check.optional).toBe(true);
    expect(check.detail).toContain('no events.ndjson yet');
  });

  it('is ok when events.ndjson is empty', () => {
    const check = eventLogCheck({ total: 0, unparseable: 0 });
    expect(check.ok).toBe(true);
    expect(check.optional).toBe(true);
    expect(check.detail).toContain('empty');
  });

  it('is ok with a 0 unparseable detail when there is no corruption', () => {
    const check = eventLogCheck({ total: 42, unparseable: 0 });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('0 unparseable');
  });

  it('fails as an optional check with the count and percentage when corrupted, and does not fail doctorFailed', () => {
    const check = eventLogCheck({ total: 100, unparseable: 3 });
    expect(check.ok).toBe(false);
    expect(check.optional).toBe(true);
    expect(check.detail).toContain('3 of 100');
    expect(check.detail).toContain('3.0%');
    expect(doctorFailed([check])).toBe(false);
  });
});

describe('formatReconcileReport', () => {
  it('reports no stale leases when empty', () => {
    expect(formatReconcileReport([])).toBe('reconcile: no stale leases');
  });

  it('reports one freed-port line per reap', () => {
    const report = formatReconcileReport([
      { lease: { worktreeId: '/wt/a', port: 3100 }, reason: 'dead-pid' },
      { lease: { worktreeId: '/wt/b', port: 3101 }, reason: 'missing-worktree' },
    ]);
    expect(report).toBe(
      'reconcile: freed port 3100 (worktree /wt/a, reason dead-pid)\n' +
        'reconcile: freed port 3101 (worktree /wt/b, reason missing-worktree)',
    );
  });
});

describe('formatWorktreeReconcileReport', () => {
  it('reports no dead-run worktrees when empty', () => {
    expect(formatWorktreeReconcileReport([])).toBe('reconcile: no dead-run worktrees');
  });

  it('reports a removed worktree with its deleted branch', () => {
    const report = formatWorktreeReconcileReport([
      { path: '/wt/a', branch: 'ship-it/5-x', reason: 'merged', branchDeleted: true },
    ]);
    expect(report).toBe(
      'reconcile: removed worktree /wt/a (branch ship-it/5-x, reason merged), deleted branch ship-it/5-x',
    );
  });

  it('renders a detached worktree with no deleted-branch suffix', () => {
    const report = formatWorktreeReconcileReport([
      { path: '/wt/b', branch: null, reason: 'ttl-expired', branchDeleted: false },
    ]);
    expect(report).toBe('reconcile: removed worktree /wt/b (branch detached, reason ttl-expired)');
  });

  it('joins multiple entries with a single newline', () => {
    const report = formatWorktreeReconcileReport([
      { path: '/wt/a', branch: 'ship-it/5-x', reason: 'merged', branchDeleted: true },
      { path: '/wt/b', branch: null, reason: 'ttl-expired', branchDeleted: false },
    ]);
    expect(report).toBe(
      'reconcile: removed worktree /wt/a (branch ship-it/5-x, reason merged), deleted branch ship-it/5-x\n' +
        'reconcile: removed worktree /wt/b (branch detached, reason ttl-expired)',
    );
  });
});

describe('formatClaimReconcileReport', () => {
  it('reports no stale claims when empty', () => {
    expect(formatClaimReconcileReport([])).toBe('reconcile: no stale claims');
  });

  it('reports a released claim', () => {
    const report = formatClaimReconcileReport([{ issue: 42, expiresAt: 1_700_000_000, released: true }]);
    expect(report).toBe('reconcile: released issue #42 back to factory:queued (lease expired at 1700000000)');
  });

  it('reports a failed release with its detail', () => {
    const report = formatClaimReconcileReport([
      { issue: 42, expiresAt: 1_700_000_000, released: false, detail: 'boom' },
    ]);
    expect(report).toBe('reconcile: failed to release issue #42 (lease expired at 1700000000): boom');
  });

  it('joins multiple entries with a single newline', () => {
    const report = formatClaimReconcileReport([
      { issue: 42, expiresAt: 1_700_000_000, released: true },
      { issue: 43, expiresAt: 1_700_000_100, released: false, detail: 'boom' },
    ]);
    expect(report).toBe(
      'reconcile: released issue #42 back to factory:queued (lease expired at 1700000000)\n' +
        'reconcile: failed to release issue #43 (lease expired at 1700000100): boom',
    );
  });
});

describe('unmergedGreenPrChecks', () => {
  it('renders a single passing optional check when there are no rows', () => {
    const checks = unmergedGreenPrChecks({ status: 'ok', rows: [] });
    expect(checks).toEqual([
      {
        name: 'green PRs awaiting merge',
        ok: true,
        optional: true,
        detail: 'no green-and-ready PRs awaiting merge',
      },
    ]);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('renders a row with an issue as a non-ok optional check', () => {
    const result: GreenPrScanResult = {
      status: 'ok',
      rows: [{ number: 957, branch: 'ship-it/939-x', issue: 939, ageHours: 9 }],
    };
    const checks = unmergedGreenPrChecks(result);
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('green PR #957');
    expect(checks[0].ok).toBe(false);
    expect(checks[0].optional).toBe(true);
    expect(checks[0].detail).toContain('issue #939');
    expect(checks[0].detail).toContain('ship-it/939-x');
    expect(checks[0].detail).toContain('open 9h');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('renders "owning issue unknown" when a row has no issue', () => {
    const result: GreenPrScanResult = {
      status: 'ok',
      rows: [{ number: 1, branch: 'some-branch', issue: null, ageHours: 1 }],
    };
    const checks = unmergedGreenPrChecks(result);
    expect(checks[0].detail).toContain('owning issue unknown');
  });

  it('renders a passing optional check when skipped', () => {
    const checks = unmergedGreenPrChecks({ status: 'skipped', detail: 'skipped — no GitHub repo or token' });
    expect(checks).toEqual([
      { name: 'green PRs awaiting merge', ok: true, optional: true, detail: 'skipped — no GitHub repo or token' },
    ]);
  });

  it('renders a failing optional check when the scan failed, and never fails doctor', () => {
    const checks = unmergedGreenPrChecks({ status: 'failed', detail: 'boom' });
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].optional).toBe(true);
    expect(checks[0].detail).toContain('scan failed: boom');
    expect(doctorFailed(checks)).toBe(false);
  });
});

describe('sandboxClaudeAuthChecks', () => {
  function result(overrides: Partial<ClaudeAuthProbeResult> = {}): ClaudeAuthProbeResult {
    return {
      host: 'ok',
      sandboxed: 'ok',
      hostDetail: 'claude -p succeeded on the host',
      sandboxDetail: 'claude -p succeeded under sandbox-exec',
      ...overrides,
    };
  }

  it('reports two distinct check names, both ok, when host and sandboxed both succeed', () => {
    const checks = sandboxClaudeAuthChecks(result());
    expect(checks).toHaveLength(2);
    expect(new Set(checks.map((c) => c.name)).size).toBe(2);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('fails closed (hard failure) when host is ok but sandboxed failed, and the fix mentions FACTORY_SANDBOX=0', () => {
    const checks = sandboxClaudeAuthChecks(
      result({ sandboxed: 'failed', sandboxDetail: 'claude -p failed under sandbox-exec (local_auth)' }),
    );
    const sandboxCheck = checks.find((c) => c.name === 'claude auth (sandboxed)')!;
    expect(sandboxCheck.ok).toBe(false);
    expect(sandboxCheck.optional).toBeFalsy();
    expect(sandboxCheck.fix).toContain('FACTORY_SANDBOX=0');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('reports an optional passing check when sandboxed is skipped', () => {
    const checks = sandboxClaudeAuthChecks(
      result({ sandboxed: 'skipped', sandboxDetail: 'skipped — sandbox disabled' }),
    );
    const sandboxCheck = checks.find((c) => c.name === 'claude auth (sandboxed)')!;
    expect(sandboxCheck.ok).toBe(true);
    expect(sandboxCheck.optional).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('does not blame the sandbox when the host itself is failing — sandboxed check is optional', () => {
    const checks = sandboxClaudeAuthChecks(
      result({
        host: 'failed',
        hostDetail: 'claude -p failed on the host',
        sandboxed: 'failed',
        sandboxDetail: 'claude -p failed under sandbox-exec (local_auth)',
      }),
    );
    const hostCheck = checks.find((c) => c.name === 'claude auth (host)')!;
    const sandboxCheck = checks.find((c) => c.name === 'claude auth (sandboxed)')!;
    expect(hostCheck.ok).toBe(false);
    expect(hostCheck.optional).toBeFalsy();
    expect(sandboxCheck.ok).toBe(false);
    expect(sandboxCheck.optional).toBe(true);
  });

  it('reports both checks as optional passes when both are skipped, and never fails doctor', () => {
    const checks = sandboxClaudeAuthChecks(
      result({
        host: 'skipped',
        hostDetail: 'skipped — claude CLI not on PATH',
        sandboxed: 'skipped',
        sandboxDetail: 'skipped — host claude auth was not verified',
      }),
    );
    expect(checks.every((c) => c.ok && c.optional)).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });
});

describe('claudeKeychainCheck', () => {
  it('passes skipped probes as optional and preserves their detail', () => {
    const check = claudeKeychainCheck({ status: 'skipped', detail: 'skipped — not macOS' });
    expect(check).toMatchObject({ ok: true, optional: true, detail: 'skipped — not macOS' });
    expect(doctorFailed([check])).toBe(false);
  });

  it('passes when the login keychain entry is readable', () => {
    const check = claudeKeychainCheck({ status: 'readable' });
    expect(check.ok).toBe(true);
    expect(check.optional).toBeFalsy();
    expect(check.detail).toContain("login keychain entry 'Claude Code-credentials' is readable");
  });

  it('hard-fails when the keychain is unreadable inside tmux', () => {
    const check = claudeKeychainCheck({ status: 'unreadable', inTmux: true });
    expect(check.ok).toBe(false);
    expect(check.optional).toBeFalsy();
    expect(check.detail).toContain('tmux');
    expect(check.detail).toContain('SecKeychainSearchCopyNext');
    expect(check.fix).toContain('gui/$(id -u)');
    expect(check.fix).toContain('docs/runbooks/macos-keychain-launchagent.md');
    expect(doctorFailed([check])).toBe(true);
  });

  it('warns without failing doctor when the keychain is unreadable outside tmux', () => {
    const check = claudeKeychainCheck({ status: 'unreadable', inTmux: false });
    expect(check).toMatchObject({ ok: false, optional: true });
    expect(check.fix).toContain('/login');
    expect(doctorFailed([check])).toBe(false);
  });
});

describe('claudeKeychainCheck for a CLAUDE_CONFIG_DIR profile', () => {
  const profile = { service: 'Claude Code-credentials-685abfe8', configDir: '/home/dev/.claude-work' };

  it("names the selected profile's keychain entry when readable", () => {
    const check = claudeKeychainCheck({ status: 'readable', ...profile });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("login keychain entry 'Claude Code-credentials-685abfe8'");
    expect(check.detail).toContain('CLAUDE_CONFIG_DIR=/home/dev/.claude-work');
  });

  it('names the profile entry in the tmux hard-fail', () => {
    const check = claudeKeychainCheck({ status: 'unreadable', inTmux: true, ...profile });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("-s 'Claude Code-credentials-685abfe8'");
  });

  it('tells the user to log in under the same profile', () => {
    const check = claudeKeychainCheck({ status: 'unreadable', inTmux: false, ...profile });
    expect(check).toMatchObject({ ok: false, optional: true });
    expect(check.detail).toContain("-s 'Claude Code-credentials-685abfe8'");
    expect(check.fix).toContain('CLAUDE_CONFIG_DIR=/home/dev/.claude-work claude');
  });

  it('keeps the default entry name and plain `claude` fix when no profile is given', () => {
    const check = claudeKeychainCheck({ status: 'unreadable', inTmux: false });
    expect(check.detail).toContain("-s 'Claude Code-credentials' failed");
    expect(check.fix).toContain('run `claude` and complete /login');
  });
});

describe('keychainPreflightError', () => {
  it("names the selected profile's keychain entry inside tmux", () => {
    const error = keychainPreflightError({
      status: 'unreadable',
      inTmux: true,
      service: 'Claude Code-credentials-685abfe8',
      configDir: '/home/dev/.claude-work',
    });
    expect(error).toContain("-s 'Claude Code-credentials-685abfe8'");
  });

  it('returns null unless the keychain is unreadable inside tmux', () => {
    expect(keychainPreflightError({ status: 'readable' })).toBeNull();
    expect(keychainPreflightError({ status: 'skipped', detail: 'skipped — not macOS' })).toBeNull();
    expect(keychainPreflightError({ status: 'unreadable', inTmux: false })).toBeNull();
  });

  it('describes the local_auth risk and launchd remediation inside tmux', () => {
    const error = keychainPreflightError({ status: 'unreadable', inTmux: true });
    expect(error).toContain('local_auth');
    expect(error).toContain('tmux');
    expect(error).toContain('launchctl bootstrap gui/$(id -u)');
    expect(error).toContain('docs/runbooks/macos-keychain-launchagent.md');
  });
});

describe('orphanContainerChecks', () => {
  it('reports a single ok check when there are no orphans', () => {
    const checks = orphanContainerChecks([]);
    expect(checks).toEqual([
      { name: 'orphan containers', ok: true, detail: 'no orphan sf-job-*/factory.managed containers' },
    ]);
    expect(checks[0].optional).toBeUndefined();
    expect(doctorFailed(checks)).toBe(false);
  });

  it('reports one non-optional failing check per orphan name, failing doctor overall', () => {
    const checks = orphanContainerChecks(['sf-job-1', 'sf-job-2']);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toEqual({
      name: 'orphan container sf-job-1',
      ok: false,
      detail: 'sf-job-1 is stopped and not tied to any running job',
      fix: 'run `factory doctor --reconcile` to remove it and its anonymous volumes',
    });
    expect(checks[0].optional).toBeUndefined();
    expect(doctorFailed(checks)).toBe(true);
  });
});

describe('orphanMicroVmChecks', () => {
  it('reports a single ok check when there are no orphans', () => {
    const checks = orphanMicroVmChecks([]);
    expect(checks).toEqual([{ name: 'orphan sbx VMs', ok: true, detail: 'no orphan factory-* sbx VMs' }]);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('reports one non-optional failing check per orphan name, failing doctor overall', () => {
    const checks = orphanMicroVmChecks(['factory-abc123']);
    expect(checks).toEqual([
      {
        name: 'orphan sbx VM factory-abc123',
        ok: false,
        detail: 'factory-abc123 has no active lane holding its worktree',
        fix: 'run `factory doctor --reconcile` to remove it via `sbx rm --force`',
      },
    ]);
    expect(doctorFailed(checks)).toBe(true);
  });
});

describe('formatContainerReconcileReport', () => {
  it('reports no orphan containers when empty', () => {
    expect(formatContainerReconcileReport([])).toBe('reconcile: no orphan containers');
  });

  it('reports a removed line for a successful reap', () => {
    const rows: ReapRow[] = [{ name: 'sf-job-1', removed: true, detail: 'docker rm -f -v sf-job-1 ok' }];
    expect(formatContainerReconcileReport(rows)).toBe('reconcile: removed container sf-job-1');
  });

  it('reports a failed line with detail for a failed reap', () => {
    const rows: ReapRow[] = [
      { name: 'sf-job-1', removed: false, detail: 'docker rm -f -v sf-job-1 failed: no such container' },
    ];
    expect(formatContainerReconcileReport(rows)).toBe(
      'reconcile: failed to remove container sf-job-1: docker rm -f -v sf-job-1 failed: no such container',
    );
  });

  it('joins multiple rows with a single newline', () => {
    const rows: ReapRow[] = [
      { name: 'sf-job-1', removed: true, detail: 'ok' },
      { name: 'sf-job-2', removed: false, detail: 'boom' },
    ];
    expect(formatContainerReconcileReport(rows)).toBe(
      'reconcile: removed container sf-job-1\nreconcile: failed to remove container sf-job-2: boom',
    );
  });
});

describe('formatMicroVmReconcileReport', () => {
  it('reports no orphan sbx VMs when empty', () => {
    expect(formatMicroVmReconcileReport([])).toBe('reconcile: no orphan sbx VMs');
  });

  it('reports a removed line for a successful reap', () => {
    const rows: ReapRow[] = [{ name: 'factory-abc123', removed: true, detail: 'sbx rm --force factory-abc123 ok' }];
    expect(formatMicroVmReconcileReport(rows)).toBe('reconcile: removed sbx VM factory-abc123 (sbx rm --force)');
  });

  it('reports a failed line with detail for a failed reap', () => {
    const rows: ReapRow[] = [
      { name: 'factory-abc123', removed: false, detail: 'sbx rm --force factory-abc123 failed: not found' },
    ];
    expect(formatMicroVmReconcileReport(rows)).toBe(
      'reconcile: failed to remove sbx VM factory-abc123: sbx rm --force factory-abc123 failed: not found',
    );
  });
});

describe('declaredHarnessChecks', () => {
  it('reports a passing probe as an ok check', () => {
    const [check] = declaredHarnessChecks([
      { harness: 'my-agent', probe: 'my-agent --version', status: 'available', detail: '' },
    ]);
    expect(check).toEqual({ name: 'harness my-agent', ok: true, detail: 'available (probe: my-agent --version)' });
  });

  it('reports a failing probe as a non-optional failed check with the failure and a fix', () => {
    const checks = declaredHarnessChecks([
      { harness: 'my-agent', probe: 'my-agent --version', status: 'unavailable', detail: 'exit 127: not found' },
    ]);
    expect(checks[0]).toMatchObject({
      name: 'harness my-agent',
      ok: false,
      detail: 'unavailable: probe `my-agent --version` failed: exit 127: not found',
    });
    expect(checks[0].optional).toBeUndefined();
    expect(checks[0].fix).toContain('probe');
    expect(doctorFailed(checks)).toBe(true);
  });

  it('reports a harness without a probe as an optional unverified check', () => {
    const checks = declaredHarnessChecks([{ harness: 'my-agent', status: 'unverified', detail: '' }]);
    expect(checks[0]).toMatchObject({
      name: 'harness my-agent',
      ok: false,
      optional: true,
      detail: 'unverified: no probe configured',
    });
    expect(checks[0].fix).toContain('probe');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('returns no checks for no declared harnesses', () => {
    expect(declaredHarnessChecks([])).toEqual([]);
  });
});

describe('modelsRegistryChecks', () => {
  const cfg = '/repo/.factory/config.json';
  const valid = ['opencode', 'claude-cli', 'my-agent'];

  it('returns nothing for an undefined or empty registry', () => {
    expect(modelsRegistryChecks(cfg, undefined, valid)).toEqual([]);
    expect(modelsRegistryChecks(cfg, {}, valid)).toEqual([]);
  });

  it('fails an entry with no harness, naming the path and field', () => {
    const rows = modelsRegistryChecks(cfg, { 'my-model': {} }, valid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.optional).toBeUndefined();
    expect(rows[0]?.detail).toContain(cfg);
    expect(rows[0]?.detail).toContain('models.registry.my-model.harness');
    expect(doctorFailed(rows)).toBe(true);
  });

  it('treats a whitespace-only harness as missing', () => {
    const rows = modelsRegistryChecks(cfg, { 'my-model': { harness: '   ' } }, valid);
    expect(rows[0]?.detail).toContain('is missing');
  });

  it('fails an unknown harness, naming the path, field, value and valid list', () => {
    const rows = modelsRegistryChecks(cfg, { 'my-model': { harness: 'nope' } }, valid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain(cfg);
    expect(rows[0]?.detail).toContain('models.registry.my-model.harness');
    expect(rows[0]?.detail).toContain("'nope'");
    expect(rows[0]?.detail).toContain('opencode, claude-cli, my-agent');
    expect(doctorFailed(rows)).toBe(true);
  });

  it('treats an exact-case mismatch as unknown', () => {
    expect(modelsRegistryChecks(cfg, { m: { harness: 'Opencode' } }, valid)[0]?.ok).toBe(false);
  });

  it('accepts a harness that is only declared', () => {
    const rows = modelsRegistryChecks(cfg, { m: { harness: 'my-agent' } }, valid);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('reports one ok row and no failure when every entry has a known harness', () => {
    const rows = modelsRegistryChecks(cfg, { a: { harness: 'opencode' }, b: { harness: 'claude-cli' } }, valid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'models.registry', ok: true });
    expect(rows[0]?.detail).toContain('2 entries valid');
    expect(doctorFailed(rows)).toBe(false);
  });

  it('uses the singular for one valid entry', () => {
    expect(modelsRegistryChecks(cfg, { a: { harness: 'opencode' } }, valid)[0]?.detail).toContain('1 entry valid');
  });

  it('gives one failed row per invalid entry and no ok row for a mixed registry', () => {
    const rows = modelsRegistryChecks(cfg, { a: { harness: 'opencode' }, b: {}, c: { harness: 'nope' } }, valid);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.ok)).toBe(false);
  });
});

describe('harness sign-in (#2556)', () => {
  const only =
    (...clis: string[]) =>
    (cmd: string) =>
      clis.includes(cmd);
  const noEvidence = (overrides: Partial<DoctorEnvProbes> = {}) => {
    const base = probes();
    return probes({
      envPresent: () => false,
      claudeLoggedIn: () => false,
      opencodeLoggedIn: () => false,
      tryExec: (cmd) => (cmd.includes('codex login status') ? 'Not logged in' : base.tryExec(cmd)),
      ...overrides,
    });
  };

  it('codex not logged in: the Codex sign-in row fails and its fix ends with codex login', () => {
    const checks = reconcileAgentAuthChecks(
      runDoctorChecks(noEvidence({ commandAvailable: (cmd) => cmd !== 'claude' && cmd !== 'opencode' })),
    );
    expect(checks.find((c) => c.name === 'codex signed in')).toMatchObject({
      section: 'Codex',
      ok: false,
      optional: false,
    });
    expect(checks.find((c) => c.name === 'codex signed in')!.detail).toMatch(/^unverified/);
    expect(formatDoctorChecks(checks)).toMatch(/fix: .*codex login$/m);
    expect(doctorFailed(checks)).toBe(true);
  });

  it.each([
    ['claude via stored login', 'claude signed in', { claudeLoggedIn: () => true }, undefined],
    ['claude via ANTHROPIC_API_KEY', 'claude signed in', {}, 'ANTHROPIC_API_KEY'],
    [
      'codex via codex login status',
      'codex signed in',
      { tryExec: (c: string) => (c.includes('codex login status') ? 'Logged in using an API key' : '') },
      undefined,
    ],
    ['codex via CODEX_API_KEY', 'codex signed in', {}, 'CODEX_API_KEY'],
    ['opencode via stored login', 'opencode signed in', { opencodeLoggedIn: () => true }, undefined],
    ['opencode via OPENCODE_API_KEY', 'opencode signed in', {}, 'OPENCODE_API_KEY'],
  ] as const)('evidence marks %s signed in', (_label, name, overrides, key) => {
    const checks = runDoctorChecks(noEvidence({ envPresent: (k) => k === key, ...overrides }));
    const row = checks.find((c) => c.name === name)!;
    expect(row.ok).toBe(true);
    expect(row.optional).toBeUndefined();
    const out = formatDoctorChecks([row]);
    expect(out).not.toContain('fix:');
  });

  it('no evidence shows unverified and the login command for claude and opencode', () => {
    const checks = runDoctorChecks(noEvidence());
    const claude = checks.find((c) => c.name === 'claude signed in')!;
    const opencode = checks.find((c) => c.name === 'opencode signed in')!;
    expect(claude.detail).toMatch(/^unverified/);
    expect(claude.fix).toMatch(/claude \/login$/);
    expect(opencode.detail).toMatch(/^unverified/);
    expect(opencode.fix).toMatch(/opencode auth login$/);
  });

  it('a harness that is not installed gets a skipped signed-in row that does not count as signed in', () => {
    const checks = reconcileAgentAuthChecks(runDoctorChecks(noEvidence({ commandAvailable: only('codex') })));
    for (const name of ['claude signed in', 'opencode signed in']) {
      const row = checks.find((c) => c.name === name)!;
      expect(row).toMatchObject({ ok: true, optional: true });
      expect(row.detail).toMatch(/^skipped/);
    }
    expect(doctorFailed(checks)).toBe(true);
  });

  it('makes no inference call for any of the three harnesses', () => {
    for (const evidence of [true, false]) {
      const inference = vi.fn();
      const base = evidence ? probes() : noEvidence();
      const claudeLoggedIn = vi.fn(() => evidence);
      const opencodeLoggedIn = vi.fn(() => evidence);
      const checks = runDoctorChecks({
        ...base,
        claudeLoggedIn,
        opencodeLoggedIn,
        tryExec: (cmd, opts) => {
          if (/^(claude\s+(-p|--print)|codex\s+exec|opencode\s+run)\b/.test(cmd)) inference();
          return base.tryExec(cmd, opts);
        },
      });
      expect(inference).not.toHaveBeenCalled();
      for (const cli of ['claude', 'codex', 'opencode']) {
        expect(checks.some((c) => c.name === `${cli} signed in`)).toBe(true);
      }
    }
  });

  it('a throwing stored-login probe counts as no evidence', () => {
    const checks = runDoctorChecks(
      noEvidence({
        claudeLoggedIn: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(checks.find((c) => c.name === 'claude signed in')).toMatchObject({ ok: false });
  });

  it('reconcile downgrades an unverified opencode row when another agent is signed in, else keeps it failing', () => {
    const unverified = { name: 'opencode signed in', ok: false, optional: false, detail: 'unverified — x' };
    const signedIn = { name: 'claude signed in', ok: true, detail: 'signed in' };
    const [down] = reconcileAgentAuthChecks([unverified, signedIn]);
    expect(down).toMatchObject({ ok: false, optional: true });
    expect(down!.detail).toContain('another agent is signed in');
    expect(reconcileAgentAuthChecks([unverified])[0]).toMatchObject({ ok: false, optional: false });
  });
});

describe('reconcileAgentAuthChecks (#2496)', () => {
  const claudeFailed = { name: 'claude auth (host)', ok: false, detail: 'claude -p failed on the host' };
  const claudeSkipped = { name: 'claude auth (host)', ok: true, optional: true, detail: 'skipped' };
  const codexOk = { name: 'codex signed in', ok: true, detail: 'logged in with ChatGPT' };
  const codexFailed = {
    name: 'codex signed in',
    ok: false,
    optional: true,
    detail: 'codex CLI installed but not logged in',
  };

  it('downgrades a logged-out agent to a warning while another is signed in', () => {
    const out = reconcileAgentAuthChecks([codexOk, claudeFailed]);
    expect(out[1]).toMatchObject({ ok: false, optional: true });
  });

  it('makes every logged-out agent a failure when none is signed in', () => {
    const out = reconcileAgentAuthChecks([codexFailed, claudeFailed]);
    expect(out.every((c) => c.optional === false)).toBe(true);
  });

  it('does not count a skipped probe as signed in', () => {
    const out = reconcileAgentAuthChecks([codexFailed, claudeSkipped]);
    expect(out[0]).toMatchObject({ ok: false, optional: false });
    expect(out[1]).toBe(claudeSkipped);
  });
});

describe('per-harness setup sections (#2555)', () => {
  const base = probes();
  const withVersion = (overrides: Partial<DoctorEnvProbes> = {}) =>
    probes({
      tryExec: (cmd) => (cmd === 'codex --version' ? 'codex-cli 0.47.0' : base.tryExec(cmd)),
      ...overrides,
    });

  it('renders one section per harness with its installed row', () => {
    const checks = runDoctorChecks(withVersion());
    const lines = formatDoctorChecks(checks).split('\n');
    const headers = ['-- Claude Code --', '-- Codex --', '-- OpenCode --'];
    const rows = ['claude installed', 'codex installed', 'opencode installed'];
    const idx = headers.map((h) => lines.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    headers.forEach((h, i) => {
      expect(lines.filter((l) => l === h)).toHaveLength(1);
      expect(lines[idx[i]! + 1]).toContain(rows[i]!);
    });
    const output = lines.join('\n');
    for (const c of checks) expect(output.split(`${c.name} -`).length - 1).toBe(1);
  });

  it('a missing CLI fails its installed row and ends with its install command', () => {
    const checks = runDoctorChecks(
      probes({ commandAvailable: (cmd) => !['claude', 'codex', 'opencode'].includes(cmd) }),
    );
    const output = formatDoctorChecks(checks).split('\n');
    const expected = [
      ['claude', 'Claude Code', /npm install -g @anthropic-ai\/claude-code$/],
      ['codex', 'Codex', /npm install -g @openai\/codex$/],
      ['opencode', 'OpenCode', /npm install -g opencode-ai$/],
    ] as const;
    for (const [cli, section, re] of expected) {
      const row = checks.find((c) => c.name === `${cli} installed`)!;
      expect(row).toMatchObject({ ok: false, section });
      expect(row.fix).toMatch(re);
      const at = output.findIndex((l) => l.includes(`${cli} installed`));
      expect(output[at + 1]).toMatch(re);
      expect(output[at + 1]).toContain('fix:');
    }
  });

  it('an installed codex CLI passes and shows its version', () => {
    const checks = runDoctorChecks(withVersion());
    const row = checks.find((c) => c.name === 'codex installed')!;
    expect(row.ok).toBe(true);
    expect(row.detail).toContain('codex-cli 0.47.0');
    expect(formatDoctorChecks(checks)).toContain('  ✅ codex installed - found on PATH (codex-cli 0.47.0)');
  });

  it('harnessInstallChecks handles null, empty and multi-line version output', () => {
    const detail = (out: string | null) =>
      harnessInstallChecks(
        () => true,
        () => out,
      ).find((c) => c.name === 'claude installed')!.detail;
    expect(detail(null)).toBe('found on PATH (version unknown)');
    expect(detail('')).toBe('found on PATH (version unknown)');
    expect(detail('  \n ')).toBe('found on PATH (version unknown)');
    expect(detail('1.2.3 (Claude Code)\nextra line')).toBe('found on PATH (1.2.3 (Claude Code))');
  });

  it('formatDoctorChecks puts unsectioned rows first and keeps totals', () => {
    const output = formatDoctorChecks([
      { name: 'a', ok: true, detail: 'x', section: 'S' },
      { name: 'b', ok: true, detail: 'y' },
      { name: 'c', ok: false, optional: true, detail: 'z', section: 'S' },
      { name: 'd', ok: false, detail: 'w' },
    ]);
    expect(output).toContain(['  ✅ b - y', '  ❌ d - w', '-- S --', '  ✅ a - x', '  ⚠️ c - z'].join('\n'));
    expect(output).toContain('2 passed, 1 failed, 1 warnings');
  });
});

describe('factory --help first step (#2558)', () => {
  it('PREREQUISITES_TEXT opens by naming factory doctor as the first step', () => {
    const firstLine = PREREQUISITES_TEXT.split('\n')[0];
    expect(firstLine).toMatch(/first step/i);
    expect(firstLine).toContain('factory doctor');
  });
});

describe('configLintChecks (#2610, #2612)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const PLACEHOLDER_CONSTITUTION =
    '---\nproduct: acme\nversion: 1\ncheckers:\n  - <checker-name>\n  - compile\n---\nbody\n';
  const VALID_CONSTITUTION = PLACEHOLDER_CONSTITUTION.replace('<checker-name>', 'compile');
  const VALID_CONFIG = 'sweep:\n  enabled: false\n';

  function setup(constitution: string, config: string): ConfigLintInput {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-config-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory', 'constitution.md'), constitution);
    const y = join(dir, '.factory', 'config.yaml');
    writeFileSync(y, config);
    return {
      constitution: new ConstitutionLoader().loadRepoConstitution(dir),
      configFile: { absPath: y, relPath: '.factory/config.yaml' },
    };
  }

  it('flags a placeholder checker with file:line and the fix', () => {
    const rows = configLintChecks(setup(PLACEHOLDER_CONSTITUTION, VALID_CONFIG));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'config', ok: false, section: REPO_SECTION });
    expect(rows[0].optional).toBeUndefined();
    expect(rows[0].detail).toContain('.factory/constitution.md:5');
    expect(rows[0].detail).toContain('placeholder checker');
    expect(rows[0].detail).toContain('<checker-name>');
    expect(rows[0].fix).toContain('compile');
    expect(rows[0].fix).toContain('custom_*');
    expect(doctorFailed(rows)).toBe(true);
    const out = formatDoctorChecks(rows);
    expect(out).toContain('❌ config - .factory/constitution.md:5');
    expect(out).toContain('fix:');
  });

  it("flags unknown checker 'typecheck' at its line", () => {
    const rows = configLintChecks(setup(PLACEHOLDER_CONSTITUTION.replace('<checker-name>', 'typecheck'), VALID_CONFIG));
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toBe(".factory/constitution.md:5: unknown checker 'typecheck'");
    expect(rows[0].fix).toContain('custom_*');
  });

  it('passes when the constitution and config.yaml have no placeholders', () => {
    const rows = configLintChecks(setup(VALID_CONSTITUTION, VALID_CONFIG));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'config', ok: true });
    expect(rows[0].detail).toContain('.factory/constitution.md');
    expect(rows[0].detail).toContain('.factory/config.yaml');
    expect(doctorFailed(rows)).toBe(false);
  });

  it('reports an unfilled token in config.yaml with the generic fix', () => {
    const rows = configLintChecks(setup(VALID_CONSTITUTION, 'models:\n  pins:\n    build: <model id>\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail).toBe(".factory/config.yaml:3: unfilled template token '<model id>'");
    expect(rows[0].fix).toBe("replace '<model id>' with a real value");
  });

  it('passes with a neutral detail when neither file exists', () => {
    const rows = configLintChecks({
      constitution: null,
      configFile: { absPath: '/nonexistent/b.yaml', relPath: 'b.yaml' },
    });
    expect(rows).toEqual([
      { name: 'config', ok: true, section: REPO_SECTION, detail: 'no constitution or config file to scan' },
    ]);
  });

  it('returns a single failing row when the constitution could not be parsed', () => {
    const rows = configLintChecks({ constitution: null }, 'cannot parse constitution: bad yaml');
    expect(rows).toEqual([
      {
        name: 'config',
        ok: false,
        section: REPO_SECTION,
        detail: 'cannot parse constitution: bad yaml',
        fix: 'fix the constitution frontmatter YAML',
      },
    ]);
  });

  it('leaves the constitution and config file byte-identical', () => {
    const input = setup(PLACEHOLDER_CONSTITUTION, 'models:\n  pins:\n    build: <model id>\n');
    const paths = [input.constitution?.repoInstance?.absPath as string, input.configFile?.absPath as string];
    const snap = () => paths.map((p) => [readFileSync(p, 'utf-8'), statSync(p).mtimeMs]);
    const before = snap();
    configLintChecks(input);
    expect(snap()).toEqual(before);
  });
});

describe('config lint parity with the run preflight (#2612)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const fm = (checkers: string, body = 'body') =>
    `---\nproduct: acme\nversion: 1\ncheckers:${checkers}\n---\n${body}\n`;
  const CLEAN_CONFIG = 'sweep:\n  enabled: false\n';
  const fixtures: { name: string; constitution: string | null; config: string; verdict: 'ok' | 'escalate' | 'park' }[] =
    [
      { name: 'clean', constitution: fm('\n  - compile'), config: CLEAN_CONFIG, verdict: 'ok' },
      {
        name: 'placeholder checker',
        constitution: fm('\n  - <checker-name>'),
        config: CLEAN_CONFIG,
        verdict: 'escalate',
      },
      {
        name: 'unknown checker typecheck',
        constitution: fm('\n  - typecheck'),
        config: CLEAN_CONFIG,
        verdict: 'escalate',
      },
      { name: 'custom_foo checker', constitution: fm('\n  - custom_foo'), config: CLEAN_CONFIG, verdict: 'ok' },
      {
        name: 'frontmatter token',
        constitution: '---\nproduct: <product name>\nversion: 1\ncheckers:\n  - compile\n---\nbody\n',
        config: CLEAN_CONFIG,
        verdict: 'park',
      },
      {
        name: 'token only in body',
        constitution: fm('\n  - compile', 'see <thing>'),
        config: CLEAN_CONFIG,
        verdict: 'ok',
      },
      {
        name: 'config.yaml token',
        constitution: fm('\n  - compile'),
        config: 'models:\n  pins:\n    build: <model id>\n',
        verdict: 'park',
      },
      {
        name: 'commented-out token',
        constitution: fm('\n  - compile'),
        config: '# build: <model id>\nsweep:\n  enabled: false\n',
        verdict: 'ok',
      },
      {
        name: 'flow-list unknown checker',
        constitution: fm(' [compile, bogus]'),
        config: CLEAN_CONFIG,
        verdict: 'escalate',
      },
      {
        name: 'unknown checker plus config token',
        constitution: fm('\n  - typecheck'),
        config: 'models:\n  pins:\n    build: <model id>\n',
        verdict: 'escalate',
      },
      { name: 'no constitution file', constitution: null, config: CLEAN_CONFIG, verdict: 'ok' },
    ];

  it.each(fixtures)('doctor and preflight agree on $name', ({ constitution, config, verdict }) => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-parity-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.factory'));
    if (constitution !== null) writeFileSync(join(dir, '.factory', 'constitution.md'), constitution);
    const y = join(dir, '.factory', 'config.yaml');
    writeFileSync(y, config);
    const input: ConfigLintInput = {
      constitution: new ConstitutionLoader().loadRepoConstitution(dir),
      configFile: { absPath: y, relPath: '.factory/config.yaml' },
    };
    const preflight = lintFactoryConfig(input).verdict !== 'ok';
    const doctor = doctorFailed(configLintChecks(input));
    expect(doctor).toBe(preflight);
    expect(lintFactoryConfig(input).verdict).toBe(verdict);
  });
});
