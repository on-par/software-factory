import { describe, expect, it } from 'vitest';

import {
  type DoctorEnvProbes,
  doctorFailed,
  formatDoctorChecks,
  formatReconcileReport,
  leaseChecks,
  type LeaseHealthRow,
  runDoctorChecks,
} from './doctor.js';

function probes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => true,
    envPresent: () => true,
    tryExec: (cmd: string) => {
      if (cmd.includes('git rev-parse')) return '/repo';
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('gh auth token')) return 'gho_token';
      if (cmd.includes('gh auth status')) return 'Logged in';
      return '';
    },
    pathExists: () => true,
    ...overrides,
  };
}

describe('runDoctorChecks', () => {
  it('all-green: 8 checks, every ok true, doctorFailed false', () => {
    const checks = runDoctorChecks(probes());
    expect(checks).toHaveLength(8);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('claude CLI missing fails with the Claude Code fix', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'claude' }));
    const claude = checks.find((c) => c.name === 'claude CLI')!;
    expect(claude.ok).toBe(false);
    expect(claude.fix).toContain('install Claude Code first:');
    expect(doctorFailed(checks)).toBe(true);
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

  it('when git rev-parse fails, git worktree clean and .factory initialized skip/fail and doctorFailed is true', () => {
    const checks = runDoctorChecks(
      probes({
        tryExec: (cmd) => {
          if (cmd.includes('git rev-parse')) return null;
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
    expect(worktree.ok).toBe(false);
    expect(worktree.optional).toBe(true);
    expect(factoryInit.ok).toBe(false);
    expect(factoryInit.optional).toBe(true);
    expect(doctorFailed(checks)).toBe(true);
  });

  it('a dirty tree marks git worktree clean as an optional failure that does not fail doctor', () => {
    const checks = runDoctorChecks(
      probes({
        tryExec: (cmd) => {
          if (cmd.includes('git rev-parse')) return '/repo';
          if (cmd.includes('git status --porcelain')) return ' M file';
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
    expect(factoryInit.optional).toBe(true);
    expect(factoryInit.detail).toBe('.factory/ missing');
    expect(factoryInit.fix).toBe('run `factory init`');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('codex missing is an optional failure only', () => {
    const checks = runDoctorChecks(probes({ commandAvailable: (cmd) => cmd !== 'codex' }));
    const codex = checks.find((c) => c.name === 'codex sandbox')!;
    expect(codex.ok).toBe(false);
    expect(codex.optional).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
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
        detail: 'codex CLI not found — codex build routes unavailable',
        fix: 'install the codex CLI, or rely on claude routes',
      },
    ];
    expect(formatDoctorChecks(checks)).toMatchInlineSnapshot(`
      "== factory doctor ==
        ✅ git repository — /path/to/repo
        ❌ claude CLI — not found on PATH
             fix: install Claude Code first: https://docs.anthropic.com/en/docs/claude-code
        ❌ codex sandbox — codex CLI not found — codex build routes unavailable
             fix: install the codex CLI, or rely on claude routes
      1 passed, 1 failed, 1 warnings

      Model reachability: factory models --doctor"
    `);
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
