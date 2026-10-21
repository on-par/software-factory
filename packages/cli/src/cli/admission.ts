// packages/cli/src/cli/admission.ts — Factory App admission-state reader wiring + `factory queue reconcile` (#1497).

import {
  classifyQueueCompatibility,
  createFileAdmissionStateReader,
  formatAdmissionConflict,
  type AdmissionStateReader,
  type QueueCompatibilityVerdict,
  type QueueSnapshot,
  type StatelessLaneIssue,
} from '@on-par/factory-core/internal';

export interface QueueAdmissionRow {
  lane: string;
  issue: number;
  verdict: QueueCompatibilityVerdict;
}

export function admissionStateReaderFor(stateDir: string): AdmissionStateReader {
  return createFileAdmissionStateReader({ stateDir });
}

export function formatQueueAdmissionReport(rows: readonly QueueAdmissionRow[]): string {
  const conflicts = rows.filter((row) => row.verdict.kind === 'refuse');
  const lines = [`queue reconcile — ${rows.length} queued issue(s), ${conflicts.length} conflict(s)`];

  if (conflicts.length === 0) {
    lines.push('  no Factory App admission conflicts — the GitHub label queue is authoritative here');
    return lines.join('\n');
  }

  for (const row of conflicts) {
    const verdict = row.verdict as Extract<QueueCompatibilityVerdict, { kind: 'refuse' }>;
    const [head, ...rest] = formatAdmissionConflict(row.issue, verdict).split('\n');
    lines.push(`  [${row.lane}] ${head}`, ...rest.map((line) => `  ${line}`));
  }

  return lines.join('\n');
}

export function formatStatelessLaneReport(issues: readonly StatelessLaneIssue[]): string {
  const lines = [`queue reconcile — ${issues.length} lane-labelled issue(s) with no state label`];
  if (issues.length === 0) {
    lines.push('  no lane-labelled issues without a state label');
    return lines.join('\n');
  }
  for (const issue of issues) {
    for (const lane of issue.lanes) {
      lines.push(
        `  [${lane}] #${issue.issue} has factory:lane:${lane} but no state label (factory:queued, factory:parked or factory:in-progress)`,
      );
    }
  }
  return lines.join('\n');
}

export async function runQueueReconcile(deps: {
  readSnapshot: () => Promise<QueueSnapshot>;
  reader: AdmissionStateReader;
  lane?: string;
  readStatelessLaneIssues?: () => Promise<StatelessLaneIssue[]>;
}): Promise<{ report: string; conflicts: number; stateless: number }> {
  const snapshot = await deps.readSnapshot();
  const entries =
    deps.lane === undefined ? snapshot.entries : snapshot.entries.filter((entry) => entry.lane === deps.lane);

  const rows: QueueAdmissionRow[] = [];
  for (const entry of entries) {
    let lookup;
    try {
      lookup = await deps.reader.read(entry.issue);
    } catch (err) {
      lookup = { kind: 'unreadable' as const, detail: err instanceof Error ? err.message : String(err) };
    }
    rows.push({ lane: entry.lane, issue: entry.issue, verdict: classifyQueueCompatibility(entry.issue, lookup) });
  }

  const conflicts = rows.filter((row) => row.verdict.kind === 'refuse').length;
  let report = formatQueueAdmissionReport(rows);
  let stateless = 0;
  if (deps.readStatelessLaneIssues) {
    try {
      const all = await deps.readStatelessLaneIssues();
      const lane = deps.lane;
      const shown = lane === undefined ? all : all.filter((issue) => issue.lanes.includes(lane));
      stateless = shown.length;
      report += `\n${formatStatelessLaneReport(shown)}`;
    } catch (err) {
      report += `\nqueue reconcile — lane label scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { report, conflicts, stateless };
}
