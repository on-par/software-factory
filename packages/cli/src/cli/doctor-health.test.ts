// packages/cli/src/cli/doctor-health.test.ts — runtime-health row and reconcile report tests, moved from doctor.test.ts (#2799)

import { describe, expect, it } from 'vitest';

import { doctorFailed, runDoctorChecks, type DoctorEnvProbes } from './doctor.js';
import {
  analyzeEventLog,
  eventLogCheck,
  formatContainerReconcileReport,
  formatClaimReconcileReport,
  formatMicroVmReconcileReport,
  formatReconcileReport,
  formatWorktreeReconcileReport,
  leaseChecks,
  orphanContainerChecks,
  orphanMicroVmChecks,
  statelessLaneIssueChecks,
  unmergedGreenPrChecks,
  type GreenPrScanResult,
  type LeaseHealthRow,
  type ReapRow,
} from './doctor-health.js';

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

describe('statelessLaneIssueChecks', () => {
  it('renders one passing optional row when there are none', () => {
    const checks = statelessLaneIssueChecks({ status: 'ok', issues: [] });
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(true);
    expect(checks[0].optional).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('renders one non-ok optional row per issue', () => {
    const checks = statelessLaneIssueChecks({
      status: 'ok',
      issues: [{ issue: 267, lanes: ['mac-v1', 'web'], labels: [] }],
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('lane issue #267');
    expect(checks[0].ok).toBe(false);
    expect(checks[0].optional).toBe(true);
    expect(checks[0].detail).toContain('factory:lane:mac-v1, factory:lane:web');
    expect(checks[0].fix).toContain('factory queue add mac-v1 267');
    expect(doctorFailed(checks)).toBe(false);
  });

  it('renders a skipped row', () => {
    const checks = statelessLaneIssueChecks({ status: 'skipped', detail: 'skipped — no GitHub repo or token' });
    expect(checks[0]).toMatchObject({ ok: true, optional: true, detail: 'skipped — no GitHub repo or token' });
  });

  it('renders a failed scan as an optional row', () => {
    const checks = statelessLaneIssueChecks({ status: 'failed', detail: 'boom' });
    expect(checks[0].ok).toBe(false);
    expect(checks[0].optional).toBe(true);
    expect(checks[0].detail).toBe('scan failed: boom');
    expect(doctorFailed(checks)).toBe(false);
  });
});
