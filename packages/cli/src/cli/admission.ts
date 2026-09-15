// packages/cli/src/cli/admission.ts — Factory App admission-state reader wiring + `factory queue reconcile` (#1497).

import {
  classifyQueueCompatibility,
  createFileAdmissionStateReader,
  formatAdmissionConflict,
  type AdmissionStateReader,
  type QueueCompatibilityVerdict,
  type QueueSnapshot,
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

export async function runQueueReconcile(deps: {
  readSnapshot: () => Promise<QueueSnapshot>;
  reader: AdmissionStateReader;
  lane?: string;
}): Promise<{ report: string; conflicts: number }> {
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
  return { report: formatQueueAdmissionReport(rows), conflicts };
}
