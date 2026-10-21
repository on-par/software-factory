// packages/cli/src/cli/admission.test.ts — runQueueReconcile + report formatting (#1497).

import { describe, expect, it } from 'vitest';
import type { AdmissionLookup, QueueSnapshot, StatelessLaneIssue } from '@on-par/factory-core/internal';

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

describe('runQueueReconcile stateless lane issues', () => {
  const issue267: StatelessLaneIssue = {
    issue: 267,
    lanes: ['mac-v1'],
    labels: ['enhancement', 'ios', 'factory:lane:mac-v1'],
  };
  const base = { readSnapshot: snapshotWith([]), reader: readerReturning({}) };

  it('reports a lane-labelled issue with no state label', async () => {
    const { report, stateless, conflicts } = await runQueueReconcile({
      ...base,
      readStatelessLaneIssues: async () => [issue267],
    });
    expect(report).toContain('[mac-v1] #267 has factory:lane:mac-v1 but no state label');
    expect(stateless).toBe(1);
    expect(conflicts).toBe(0);
  });

  it('reports none when every lane issue has a state label', async () => {
    const { report, stateless } = await runQueueReconcile({ ...base, readStatelessLaneIssues: async () => [] });
    expect(report).toContain('no lane-labelled issues without a state label');
    expect(stateless).toBe(0);
  });

  it('limits stateless lines to --lane', async () => {
    const { report, stateless } = await runQueueReconcile({
      ...base,
      lane: 'web',
      readStatelessLaneIssues: async () => [issue267, { issue: 9, lanes: ['web'], labels: ['factory:lane:web'] }],
    });
    expect(stateless).toBe(1);
    expect(report).toContain('[web] #9');
    expect(report).not.toContain('#267');
  });

  it('prints the scan failure and keeps the admission report', async () => {
    const { report, stateless, conflicts } = await runQueueReconcile({
      ...base,
      readStatelessLaneIssues: async () => {
        throw new Error('rate limited');
      },
    });
    expect(report).toContain('no Factory App admission conflicts');
    expect(report).toContain('queue reconcile — lane label scan failed: rate limited');
    expect(stateless).toBe(0);
    expect(conflicts).toBe(0);
  });
});
