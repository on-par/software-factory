// packages/cli/src/cli/doctor-health.ts — runtime-health rows and reconcile reports, moved out of doctor.ts (#2799)

import type { StatelessLaneIssue } from '@on-par/factory-core/internal';

import type { DoctorCheck } from './doctor.js';

export interface LeaseHealthRow {
  worktreeId: string;
  branch: string;
  port: number;
  pid: number;
  alive: boolean;
  reason?: 'dead-pid' | 'missing-worktree';
  portSquatted?: boolean;
}

export function leaseChecks(rows: LeaseHealthRow[]): DoctorCheck[] {
  if (rows.length === 0) {
    return [{ name: 'port leases', ok: true, optional: true, detail: 'no active leases' }];
  }

  return rows.map((row) => {
    if (row.alive) {
      return {
        name: `port lease :${row.port}`,
        ok: true,
        optional: true,
        detail: `${row.worktreeId}: port ${row.port}, pid ${row.pid}, live`,
      };
    }

    const squatted = row.portSquatted ? '; port still in use by another process' : '';
    return {
      name: `port lease :${row.port}`,
      ok: false,
      optional: true,
      detail: `${row.worktreeId}: port ${row.port}, pid ${row.pid}, stale (${row.reason})${squatted}`,
      fix: 'run `factory doctor --reconcile` to reclaim stale leases',
    };
  });
}

export interface EventLogIntegrity {
  total: number;
  unparseable: number;
}

export function analyzeEventLog(content: string): EventLogIntegrity {
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  let unparseable = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      unparseable++;
    }
  }
  return { total: lines.length, unparseable };
}

export function eventLogCheck(integrity: EventLogIntegrity | null): DoctorCheck {
  if (integrity === null) {
    return { name: 'event log integrity', ok: true, optional: true, detail: 'no events.ndjson yet' };
  }
  if (integrity.total === 0) {
    return { name: 'event log integrity', ok: true, optional: true, detail: 'events.ndjson is empty' };
  }
  const pct = ((integrity.unparseable / integrity.total) * 100).toFixed(1);
  if (integrity.unparseable === 0) {
    return {
      name: 'event log integrity',
      ok: true,
      optional: true,
      detail: `${integrity.total} lines, 0 unparseable (0.0%)`,
    };
  }
  return {
    name: 'event log integrity',
    ok: false,
    optional: true,
    detail: `${integrity.unparseable} of ${integrity.total} lines unparseable (${pct}%)`,
    fix: 'historical corruption from pre-lock parallel writes; appends are now serialized; metrics over this file carry this error bar',
  };
}

export interface ReapRow {
  name: string;
  removed: boolean;
  detail: string;
}

export function orphanContainerChecks(names: readonly string[]): DoctorCheck[] {
  if (names.length === 0) {
    return [{ name: 'orphan containers', ok: true, detail: 'no orphan sf-job-*/factory.managed containers' }];
  }
  return names.map((name) => ({
    name: `orphan container ${name}`,
    ok: false,
    detail: `${name} is stopped and not tied to any running job`,
    fix: 'run `factory doctor --reconcile` to remove it and its anonymous volumes',
  }));
}

export function orphanMicroVmChecks(names: readonly string[]): DoctorCheck[] {
  if (names.length === 0) {
    return [{ name: 'orphan sbx VMs', ok: true, detail: 'no orphan factory-* sbx VMs' }];
  }
  return names.map((name) => ({
    name: `orphan sbx VM ${name}`,
    ok: false,
    detail: `${name} has no active lane holding its worktree`,
    fix: 'run `factory doctor --reconcile` to remove it via `sbx rm --force`',
  }));
}

export function formatContainerReconcileReport(reaped: ReapRow[]): string {
  if (reaped.length === 0) return 'reconcile: no orphan containers';
  return reaped
    .map((r) =>
      r.removed
        ? `reconcile: removed container ${r.name}`
        : `reconcile: failed to remove container ${r.name}: ${r.detail}`,
    )
    .join('\n');
}

export function formatMicroVmReconcileReport(reaped: ReapRow[]): string {
  if (reaped.length === 0) return 'reconcile: no orphan sbx VMs';
  return reaped
    .map((r) =>
      r.removed
        ? `reconcile: removed sbx VM ${r.name} (sbx rm --force)`
        : `reconcile: failed to remove sbx VM ${r.name}: ${r.detail}`,
    )
    .join('\n');
}

export function formatReconcileReport(
  reaped: Array<{ lease: { worktreeId: string; port: number }; reason: string }>,
): string {
  if (reaped.length === 0) return 'reconcile: no stale leases';

  return reaped
    .map((r) => `reconcile: freed port ${r.lease.port} (worktree ${r.lease.worktreeId}, reason ${r.reason})`)
    .join('\n');
}

/** One worktree the reconcile pass removed. Structurally the subset of core's `GcCandidate`
 *  that the report renders — kept local so `doctor.ts` stays dependency-free and unit-testable. */
export interface ReconciledWorktree {
  path: string;
  branch: string | null;
  reason: string;
  branchDeleted: boolean;
}

export function formatWorktreeReconcileReport(removed: ReconciledWorktree[]): string {
  if (removed.length === 0) return 'reconcile: no dead-run worktrees';

  return removed
    .map((w) => {
      const branchLabel = w.branch ?? 'detached';
      const deleted = w.branchDeleted ? `, deleted branch ${w.branch}` : '';
      return `reconcile: removed worktree ${w.path} (branch ${branchLabel}, reason ${w.reason})${deleted}`;
    })
    .join('\n');
}

/** One claim the reconcile pass put back in the queue. Structurally the subset of core's
 *  `StaleClaimRelease` that the report renders — kept local so `doctor.ts` stays
 *  dependency-free and unit-testable. */
export interface ReleasedClaim {
  issue: number;
  expiresAt: number;
  released: boolean;
  outcome?: 'released' | 'renewed' | 'failed' | 'refused-clock-skew';
  detail?: string;
}

export function formatClaimReconcileReport(released: ReleasedClaim[]): string {
  if (released.length === 0) return 'reconcile: no stale claims';

  return released
    .map((c) =>
      c.outcome === 'refused-clock-skew'
        ? `reconcile: refused to release issue #${c.issue} (lease expired at ${c.expiresAt}): ${c.detail ?? 'local clock is skewed from GitHub'}`
        : c.outcome === 'renewed'
          ? `reconcile: skipped issue #${c.issue}: lease renewed since the stale read (was expired at ${c.expiresAt})`
          : c.released
            ? `reconcile: released issue #${c.issue} back to factory:queued (lease expired at ${c.expiresAt})`
            : `reconcile: failed to release issue #${c.issue} (lease expired at ${c.expiresAt}): ${c.detail ?? 'unknown error'}`,
    )
    .join('\n');
}

/** One green-and-ready PR nobody merged. Structurally the subset of core's `UnmergedGreenPr`
 *  the report renders — kept local so `doctor.ts` stays dependency-free and unit-testable. */
export interface UnmergedGreenPrRow {
  number: number;
  branch: string;
  issue: number | null;
  ageHours: number;
}

/** Outcome of the green-PR scan: it ran, it was skipped (no repo/token), or it failed. */
export type GreenPrScanResult =
  | { status: 'ok'; rows: UnmergedGreenPrRow[] }
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

const GREEN_PR_CHECK = 'green PRs awaiting merge';

export function unmergedGreenPrChecks(result: GreenPrScanResult): DoctorCheck[] {
  if (result.status === 'skipped') {
    return [{ name: GREEN_PR_CHECK, ok: true, optional: true, detail: result.detail }];
  }
  if (result.status === 'failed') {
    return [
      {
        name: GREEN_PR_CHECK,
        ok: false,
        optional: true,
        detail: `scan failed: ${result.detail}`,
        fix: 'check `gh auth status` and network access, then re-run `factory doctor`',
      },
    ];
  }
  if (result.rows.length === 0) {
    return [{ name: GREEN_PR_CHECK, ok: true, optional: true, detail: 'no green-and-ready PRs awaiting merge' }];
  }
  return result.rows.map((row) => ({
    name: `green PR #${row.number}`,
    ok: false,
    optional: true,
    detail: `${row.issue === null ? 'owning issue unknown' : `issue #${row.issue}`}: green and ready on ${row.branch}, open ${row.ageHours}h, not merged`,
    fix: `review and merge #${row.number} (or close it); the factory never auto-merges an orphaned PR`,
  }));
}

/** Outcome of the stateless-lane-issue scan: it ran, it was skipped (no repo/token), or it failed. */
export type StatelessLaneScanResult =
  | { status: 'ok'; issues: StatelessLaneIssue[] }
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

const STATELESS_LANE_CHECK = 'lane issues without a state label';

export function statelessLaneIssueChecks(result: StatelessLaneScanResult): DoctorCheck[] {
  if (result.status === 'skipped') {
    return [{ name: STATELESS_LANE_CHECK, ok: true, optional: true, detail: result.detail }];
  }
  if (result.status === 'failed') {
    return [
      {
        name: STATELESS_LANE_CHECK,
        ok: false,
        optional: true,
        detail: `scan failed: ${result.detail}`,
        fix: 'check `gh auth status` and network access, then re-run `factory doctor`',
      },
    ];
  }
  if (result.issues.length === 0) {
    return [
      {
        name: STATELESS_LANE_CHECK,
        ok: true,
        optional: true,
        detail: 'every lane-labelled open issue has a state label',
      },
    ];
  }
  return result.issues.map((issue) => ({
    name: `lane issue #${issue.issue}`,
    ok: false,
    optional: true,
    detail: `${issue.lanes.map((lane) => `factory:lane:${lane}`).join(', ')} but no state label (factory:queued, factory:parked or factory:in-progress)`,
    fix: `re-queue it (\`factory queue add ${issue.lanes[0]} ${issue.issue}\`), park it (add factory:parked), or remove the lane label`,
  }));
}
