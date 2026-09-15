// packages/cli/src/cli/admission.test.ts — runQueueReconcile + report formatting (#1497).

import { describe, expect, it } from 'vitest';
import type { AdmissionLookup, QueueSnapshot } from '@on-par/factory-core/internal';

import { formatQueueAdmissionReport, runQueueReconcile } from './admission.js';

function readerReturning(byIssue: Record<number, AdmissionLookup>) {
  return { read: async (issue: number) => byIssue[issue] ?? { kind: 'absent' as const } };
}

function snapshotWith(entries: QueueSnapshot['entries']): () => Promise<QueueSnapshot> {
  return async () => ({ entries });
}

describe('runQueueReconcile', () => {
  it('reports zero conflicts when every issue is claimable', async () => {
    const { report, conflicts } = await runQueueReconcile({
      readSnapshot: snapshotWith([{ lane: 'x', issue: 1 }]),
      reader: readerReturning({}),
    });
    expect(conflicts).toBe(0);
    expect(report).toContain('no Factory App admission conflicts');
  });

  it('lists only the refusing rows, each with its lane and repair pointer', async () => {
    const { report, conflicts } = await runQueueReconcile({
      readSnapshot: snapshotWith([
        { lane: 'x', issue: 1 },
        { lane: 'y', issue: 2 },
      ]),
      reader: readerReturning({
        2: { kind: 'record', record: { issue: 2, state: 'executing', deliveryId: 'del-1' } },
      }),
    });
    expect(conflicts).toBe(1);
    expect(report).toContain('[y] #2:');
    expect(report).toContain('repair:');
    expect(report).not.toContain('[x]');
  });

  it('drops entries outside the requested lane', async () => {
    const { conflicts, report } = await runQueueReconcile({
      readSnapshot: snapshotWith([
        { lane: 'x', issue: 1 },
        { lane: 'y', issue: 2 },
      ]),
      reader: readerReturning({
        1: { kind: 'record', record: { issue: 1, state: 'executing' } },
        2: { kind: 'record', record: { issue: 2, state: 'executing' } },
      }),
      lane: 'y',
    });
    expect(conflicts).toBe(1);
    expect(report).not.toContain('[x]');
    expect(report).toContain('[y]');
  });

  it('a reader that throws is classified as an unreadable conflict, not propagated', async () => {
    const { conflicts, report } = await runQueueReconcile({
      readSnapshot: snapshotWith([{ lane: 'x', issue: 1 }]),
      reader: {
        read: async () => {
          throw new Error('disk on fire');
        },
      },
    });
    expect(conflicts).toBe(1);
    expect(report).toContain('unreadable');
  });
});

describe('formatQueueAdmissionReport', () => {
  it('prints the summary line and no conflict body when there are none', () => {
    expect(formatQueueAdmissionReport([])).toBe(
      'queue reconcile — 0 queued issue(s), 0 conflict(s)\n  no Factory App admission conflicts — the GitHub label queue is authoritative here',
    );
  });
});
