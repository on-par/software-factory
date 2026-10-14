import { harnessCliCommand } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import {
  agentCliChecks,
  commandExecutable,
  type ConfiguredCommandHarness,
  commandHarnessChecks,
  repoCommandHarnesses,
  type ClaudeAuthProbeResult,
  claudeKeychainCheck,
  codexAuthMethod,
  type DoctorEnvProbes,
  doctorCheckIcon,
  doctorFailed,
  formatDoctorChecks,
  GIT_AUTH_FIX,
  GIT_AUTH_PROBE_CMD,
  GIT_AUTH_PROBE_TIMEOUT_MS,
  HARNESS_SETUP,
  harnessInstallChecks,
  harnessSignInChecks,
  gitAuthCheck,
  keychainPreflightError,
  NOT_IN_REPO_HINT,
  NOT_IN_REPO_SKIP_DETAIL,
  REPO_SECTION,
  runDoctorChecks,
  sandboxAuthSkipDetail,
  sandboxClaudeAuthChecks,
  reconcileAgentAuthChecks,
} from './doctor.js';
import { PREREQUISITES_TEXT } from './index.js';

const SIGN_IN_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'OPENCODE_API_KEY']);

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
    expect(checks.some((c) => c.name === 'codex signed in')).toBe(false);
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

describe('hints outside a git repo (#2472)', () => {
  /** factory subcommands that run without a git repo. Everything else goes through getRepoRoot. */
  const OUTSIDE_REPO_SAFE = new Set(['doctor']);

  const noRepo = (cmd: string, base: DoctorEnvProbes): string | null =>
    cmd.includes('git rev-parse') || cmd.includes('git config user.') ? null : base.tryExec(cmd);

  function probeSets(platform: NodeJS.Platform): Record<string, DoctorEnvProbes> {
    const base = probes({ platform });
    return {
      passing: { ...base, tryExec: (cmd) => noRepo(cmd, base) },
      failing: probes({
        platform,
        commandAvailable: () => false,
        envPresent: () => false,
        tryExec: () => null,
        claudeLoggedIn: () => false,
        opencodeLoggedIn: () => false,
        codexSessionState: () => 'unusable',
        distFreshness: () => ({ fresh: false, detail: 'dist stale' }),
      }),
    };
  }

  function render(env: DoctorEnvProbes): string {
    const rows = reconcileAgentAuthChecks([
      ...runDoctorChecks(env),
      ...sandboxClaudeAuthChecks({
        host: 'failed',
        sandboxed: 'skipped',
        hostDetail: 'claude -p failed on the host',
        sandboxDetail: NOT_IN_REPO_SKIP_DETAIL,
      }),
      claudeKeychainCheck({ status: 'unreadable', inTmux: true }),
    ]);
    return formatDoctorChecks(rows, { inRepo: false });
  }

  it('names no repo-bound factory command in any hint', () => {
    let failingHints = 0;
    for (const platform of ['darwin', 'linux'] as const) {
      for (const [label, env] of Object.entries(probeSets(platform))) {
        const out = render(env);
        const lines = out.split('\n');
        expect(out).not.toContain('factory models --doctor');
        expect(lines[lines.length - 1]).toBe(`Model reachability: ${NOT_IN_REPO_SKIP_DETAIL}`);
        const hints = [...lines.filter((l) => l.includes('fix:') || l.includes('next:')), lines[lines.length - 1]!];
        if (label === 'failing') failingHints += hints.length;
        for (const line of hints) {
          for (const m of line.matchAll(/(?:`|next: |reachability: |run )factory ([a-z][a-z-]*)/g)) {
            expect(OUTSIDE_REPO_SAFE.has(m[1]!), `${platform}/${label}: "${line.trim()}" names factory ${m[1]}`).toBe(
              true,
            );
          }
        }
      }
    }
    expect(failingHints).toBeGreaterThan(0);
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

  it('a harness that is not installed gets no signed-in row', () => {
    const checks = reconcileAgentAuthChecks(runDoctorChecks(noEvidence({ commandAvailable: only('codex') })));
    for (const name of ['claude signed in', 'opencode signed in']) {
      expect(checks.some((c) => c.name === name)).toBe(false);
    }
    expect(doctorFailed(checks)).toBe(true);
  });

  describe('harness auth rows (#2631)', () => {
    const names = (checks: { name: string }[]) => checks.map((c) => c.name);

    it('an installed, logged-in codex shows a passing codex signed in row and no rows for missing CLIs', () => {
      const checks = runDoctorChecks(probes({ commandAvailable: only('codex') }));
      expect(checks.find((c) => c.name === 'codex signed in')).toMatchObject({ ok: true, section: 'Codex' });
      expect(names(checks)).not.toContain('claude signed in');
      expect(names(checks)).not.toContain('opencode signed in');
    });

    it('an installed, unauthenticated opencode fails its auth row with the opencode auth login hint, and no codex row when codex is missing', () => {
      const checks = runDoctorChecks(noEvidence({ commandAvailable: only('opencode') }));
      const row = checks.find((c) => c.name === 'opencode signed in')!;
      expect(row.ok).toBe(false);
      expect(row.fix).toMatch(/opencode auth login$/);
      expect(row.next).toBe('opencode auth login');
      expect(names(checks)).not.toContain('codex signed in');
    });

    it('a missing codex CLI has no codex signed in row in checks or formatted output', () => {
      const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'codex' }));
      expect(names(checks)).not.toContain('codex signed in');
      expect(formatDoctorChecks(checks)).not.toContain('codex signed in');
      expect(checks.find((c) => c.name === 'codex installed')).toMatchObject({ ok: false });
    });

    it('each HARNESS_SETUP entry names the CLI its catalog harness probes', () => {
      for (const entry of HARNESS_SETUP) {
        expect(harnessCliCommand(entry.harnessId)).toBe(entry.cli);
      }
    });

    it('the shared harness probe decides each row via commandAvailable', () => {
      const commandAvailable = vi.fn(() => true);
      harnessSignInChecks(probes({ commandAvailable }));
      for (const cli of ['claude', 'codex', 'opencode']) {
        expect(commandAvailable).toHaveBeenCalledWith(cli);
      }
    });
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

  it('an unrefreshable stored Claude login fails the claude row with the /login fix (#2721)', () => {
    const inference = vi.fn();
    const base = noEvidence();
    const checks = runDoctorChecks({
      ...base,
      claudeLoggedIn: () => false,
      claudeSessionState: () => 'unusable',
      tryExec: (cmd, opts) => {
        if (/^(claude\s+(-p|--print)|codex\s+exec|opencode\s+run)\b/.test(cmd)) inference();
        return base.tryExec(cmd, opts);
      },
    });
    const row = checks.find((c) => c.name === 'claude signed in');
    expect(row).toMatchObject({ ok: false });
    expect(row!.detail).toContain('re-run claude login');
    expect(row!.fix).toContain('/login');
    expect(inference).not.toHaveBeenCalled();
  });

  it('an expired Claude access token with a refresh token stays signed in (#2721)', () => {
    const checks = runDoctorChecks(
      noEvidence({ claudeLoggedIn: () => true, claudeSessionState: () => 'refresh-pending' }),
    );
    expect(checks.find((c) => c.name === 'claude signed in')).toMatchObject({ ok: true });
  });

  it('a throwing Claude session probe falls back to the stored-login probe', () => {
    const checks = runDoctorChecks(
      noEvidence({
        claudeLoggedIn: () => true,
        claudeSessionState: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(checks.find((c) => c.name === 'claude signed in')).toMatchObject({ ok: true });
  });

  it.each(['claude', 'codex'] as const)(
    'fails the %s row when its last run hit local_auth with no login since (#2733)',
    (agent) => {
      const localAuthFailure = vi.fn((a: 'claude' | 'codex') =>
        a === agent ? { agent: a, at: '2026-10-13T16:00:00.000Z' } : null,
      );
      const checks = runDoctorChecks(probes({ localAuthFailure }));
      const row = checks.find((c) => c.name === `${agent} signed in`);
      expect(row).toMatchObject({ ok: false });
      expect(row!.detail).toContain(`re-run ${agent} login`);
      expect(row!.detail).toContain('2026-10-13T16:00:00.000Z');
      const other = agent === 'claude' ? 'codex' : 'claude';
      expect(checks.find((c) => c.name === `${other} signed in`)).toMatchObject({ ok: true });
    },
  );

  it('fails doctor when the only agent hit local_auth since its last login (#2733)', () => {
    const checks = runDoctorChecks(
      probes({
        commandAvailable: (cmd) => cmd !== 'codex' && cmd !== 'opencode',
        localAuthFailure: (a) => (a === 'claude' ? { agent: a, at: '2026-10-13T16:00:00.000Z' } : null),
      }),
    );
    expect(checks.find((c) => c.name === 'claude signed in')).toMatchObject({ ok: false, optional: false });
  });

  it('a throwing local-auth probe is ignored (#2733)', () => {
    const checks = runDoctorChecks(
      probes({
        localAuthFailure: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(checks.find((c) => c.name === 'claude signed in')).toMatchObject({ ok: true });
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
      ['opencode', 'OpenCode', /npm install -g opencode-ai@1\.18\.28$/],
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

describe('agentCliChecks command harnesses (#2691)', () => {
  const BUILT_INS = ['claude', 'codex', 'opencode'];
  const harness: ConfiguredCommandHarness = {
    harness: 'my-agent',
    command: 'my-agent --model {model}',
    executable: 'my-agent',
  };
  const only =
    (...names: string[]) =>
    (cmd: string) =>
      names.includes(cmd);
  const agentRow = (checks: ReturnType<typeof agentCliChecks>) => checks.find((c) => c.name === 'coding agent')!;

  it('parses the executable from a command template', () => {
    expect(commandExecutable('my-agent --model {model}')).toBe('my-agent');
    expect(commandExecutable('FOO=1 my-agent')).toBe('my-agent');
    expect(commandExecutable('./bin/agent')).toBe('./bin/agent');
    expect(commandExecutable('"my-agent" x')).toBe('my-agent');
    expect(commandExecutable('"my agent" x')).toBeNull();
    expect(commandExecutable('$(evil)')).toBeNull();
    expect(commandExecutable('')).toBeNull();
    expect(commandExecutable('{model}')).toBeNull();
  });

  it('keeps only agentic declared harnesses the registry references', () => {
    const harnesses = {
      used: { command: 'used-agent run', agentic: true },
      plain: { command: 'plain-agent', agentic: false },
      idle: { command: 'idle-agent', agentic: true },
    };
    expect(repoCommandHarnesses(harnesses, { m: { harness: 'used' }, n: { harness: 'plain' }, o: {} })).toEqual([
      { harness: 'used', command: 'used-agent run', executable: 'used-agent' },
    ]);
    expect(repoCommandHarnesses(undefined, undefined)).toEqual([]);
  });

  it('passes the coding agent row with only a command harness on PATH', () => {
    const checks = agentCliChecks(probes({ commandAvailable: only('my-agent'), commandHarnesses: () => [harness] }));
    expect(agentRow(checks)).toMatchObject({ ok: true, detail: 'found my-agent (command harness)' });
    expect(doctorFailed(checks)).toBe(false);
  });

  it('fails the coding agent row and names the configured command when the command harness executable is missing (#2691)', () => {
    const checks = agentCliChecks(probes({ commandAvailable: only(), commandHarnesses: () => [harness] }));
    const row = agentRow(checks);
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('my-agent --model {model}');
    expect(row.next).toBeUndefined();
    expect(doctorFailed(checks)).toBe(true);
  });

  it('lists each configured command harness in its own row next to the built-in agents (#2691)', () => {
    const checks = agentCliChecks(
      probes({ commandAvailable: only(...BUILT_INS, 'my-agent'), commandHarnesses: () => [harness] }),
    );
    const idx = checks.findIndex((c) => c.name === 'command harness my-agent');
    expect(idx).toBeGreaterThan(checks.findIndex((c) => c.name === 'opencode installed'));
    expect(checks[idx]).toMatchObject({ section: 'Command harness', optional: true, ok: true });
    expect(agentRow(checks).detail).toBe('found claude, codex, opencode, my-agent (command harness)');
  });

  it('fails the optional row when the executable cannot be parsed', () => {
    const [row] = commandHarnessChecks([{ harness: 'x', command: '$(x)', executable: null }], () => true);
    expect(row).toMatchObject({ ok: false, optional: true });
    expect(row!.detail).toContain('cannot parse');
  });

  it('treats a throwing probe as no command harnesses', () => {
    const base = agentCliChecks(probes({ commandAvailable: only() }));
    const thrown = agentCliChecks(
      probes({
        commandAvailable: only(),
        commandHarnesses: () => {
          throw new Error('bad config');
        },
      }),
    );
    expect(thrown).toEqual(base);
  });
});
