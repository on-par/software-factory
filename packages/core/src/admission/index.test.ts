// packages/core/src/admission/index.test.ts — verdicts, guard non-mutation, and the file transport (#1497).

import { describe, expect, it, vi } from 'vitest';

import { createGithubQueue, type QueueGitHubClient, type QueueIssue } from '../queue/github-queue.js';
import {
  ADMISSION_SNAPSHOT_VERSION,
  classifyQueueCompatibility,
  createFileAdmissionStateReader,
  FACTORY_APP_REPAIR_HINT,
  formatAdmissionConflict,
  withAdmissionGuard,
  type AdmissionLookup,
  type QueueCompatibilityVerdict,
} from './index.js';

describe('classifyQueueCompatibility', () => {
  it('absent lookup is claimable', () => {
    expect(classifyQueueCompatibility(1, { kind: 'absent' })).toEqual({ kind: 'claimable' });
  });

  it('a released record is claimable', () => {
    const lookup: AdmissionLookup = { kind: 'record', record: { issue: 1, state: 'released' } };
    expect(classifyQueueCompatibility(1, lookup)).toEqual({ kind: 'claimable' });
  });

  it('an admitted record refuses, naming the issue and delivery', () => {
    const lookup: AdmissionLookup = {
      kind: 'record',
      record: { issue: 7, state: 'admitted', deliveryId: 'del-1' },
    };
    const verdict = classifyQueueCompatibility(7, lookup);
    expect(verdict).toEqual({
      kind: 'refuse',
      state: 'admitted',
      reason: '#7 is admitted to Factory App delivery del-1 — GitHub labels are intake eligibility only',
      repair: FACTORY_APP_REPAIR_HINT,
    });
  });

  it('an admitted record without a deliveryId uses the unnamed placeholder', () => {
    const lookup: AdmissionLookup = { kind: 'record', record: { issue: 7, state: 'admitted' } };
    const verdict = classifyQueueCompatibility(7, lookup) as Extract<QueueCompatibilityVerdict, { kind: 'refuse' }>;
    expect(verdict.reason).toContain('delivery (unnamed)');
  });

  it('an executing record refuses, naming the issue and delivery', () => {
    const lookup: AdmissionLookup = { kind: 'record', record: { issue: 9, state: 'executing', deliveryId: 'del-2' } };
    const verdict = classifyQueueCompatibility(9, lookup);
    expect(verdict).toEqual({
      kind: 'refuse',
      state: 'executing',
      reason: '#9 is executing in Factory App delivery del-2',
      repair: FACTORY_APP_REPAIR_HINT,
    });
  });

  it('a decomposed record with a parent names the parent', () => {
    const lookup: AdmissionLookup = { kind: 'record', record: { issue: 3, state: 'decomposed', parent: 2 } };
    const verdict = classifyQueueCompatibility(3, lookup);
    expect(verdict).toEqual({
      kind: 'refuse',
      state: 'decomposed',
      reason: '#3 was decomposed by Factory App (child of #2)',
      repair: FACTORY_APP_REPAIR_HINT,
    });
  });

  it('a decomposed record without a parent uses the non-child wording', () => {
    const lookup: AdmissionLookup = { kind: 'record', record: { issue: 3, state: 'decomposed' } };
    const verdict = classifyQueueCompatibility(3, lookup);
    expect(verdict).toEqual({
      kind: 'refuse',
      state: 'decomposed',
      reason: '#3 was decomposed by Factory App into child issues — it is not an independent unit of work',
      repair: FACTORY_APP_REPAIR_HINT,
    });
  });

  it('unreadable refuses, carrying the detail verbatim', () => {
    const lookup: AdmissionLookup = { kind: 'unreadable', detail: 'admission.json is not valid JSON' };
    const verdict = classifyQueueCompatibility(1, lookup);
    expect(verdict).toEqual({
      kind: 'refuse',
      state: 'unreadable',
      reason:
        'Factory App admission state is unreadable (admission.json is not valid JSON) — refusing rather than risking duplicate work',
      repair: FACTORY_APP_REPAIR_HINT,
    });
  });

  it("a record's repairUrl overrides FACTORY_APP_REPAIR_HINT", () => {
    const lookup: AdmissionLookup = {
      kind: 'record',
      record: { issue: 1, state: 'admitted', repairUrl: 'https://factory-app.example/repair/1' },
    };
    const verdict = classifyQueueCompatibility(1, lookup) as Extract<QueueCompatibilityVerdict, { kind: 'refuse' }>;
    expect(verdict.repair).toBe('https://factory-app.example/repair/1');
  });
});

describe('formatAdmissionConflict', () => {
  it('renders the issue, the reason, and an indented repair line', () => {
    const verdict: Extract<QueueCompatibilityVerdict, { kind: 'refuse' }> = {
      kind: 'refuse',
      state: 'admitted',
      reason: '#5 is admitted to Factory App delivery del-1',
      repair: FACTORY_APP_REPAIR_HINT,
    };
    expect(formatAdmissionConflict(5, verdict)).toBe(
      `#5: #5 is admitted to Factory App delivery del-1\n    repair: ${FACTORY_APP_REPAIR_HINT}`,
    );
  });
});

describe('createFileAdmissionStateReader', () => {
  function readerWith(raw: string | null) {
    return createFileAdmissionStateReader({ stateDir: '/repo/.factory/state', readFile: () => raw });
  }

  it('missing file is absent', async () => {
    await expect(readerWith(null).read(1)).resolves.toEqual({ kind: 'absent' });
  });

  it('a valid snapshot with no matching record is absent', async () => {
    const raw = JSON.stringify({ version: ADMISSION_SNAPSHOT_VERSION, records: [{ issue: 2, state: 'admitted' }] });
    await expect(readerWith(raw).read(1)).resolves.toEqual({ kind: 'absent' });
  });

  it('a matching record is returned', async () => {
    const raw = JSON.stringify({
      version: ADMISSION_SNAPSHOT_VERSION,
      records: [{ issue: 1, state: 'executing', deliveryId: 'del-1' }],
    });
    await expect(readerWith(raw).read(1)).resolves.toEqual({
      kind: 'record',
      record: { issue: 1, state: 'executing', deliveryId: 'del-1' },
    });
  });

  it('invalid JSON is unreadable', async () => {
    await expect(readerWith('{ not json').read(1)).resolves.toEqual({
      kind: 'unreadable',
      detail: 'admission.json is not valid JSON',
    });
  });

  it('a non-object payload is unreadable', async () => {
    await expect(readerWith('42').read(1)).resolves.toEqual({
      kind: 'unreadable',
      detail: 'admission.json is not an object',
    });
  });

  it('an unsupported version is unreadable', async () => {
    const raw = JSON.stringify({ version: 2, records: [] });
    await expect(readerWith(raw).read(1)).resolves.toEqual({
      kind: 'unreadable',
      detail: 'unsupported admission snapshot version 2',
    });
  });

  it('records not an array is unreadable', async () => {
    const raw = JSON.stringify({ version: ADMISSION_SNAPSHOT_VERSION, records: 'nope' });
    await expect(readerWith(raw).read(1)).resolves.toEqual({
      kind: 'unreadable',
      detail: 'admission.json records is not an array',
    });
  });

  it('a record with an unknown state is unreadable', async () => {
    const raw = JSON.stringify({ version: ADMISSION_SNAPSHOT_VERSION, records: [{ issue: 1, state: 'bogus' }] });
    await expect(readerWith(raw).read(1)).resolves.toEqual({
      kind: 'unreadable',
      detail: 'issue #1 has unknown admission state "bogus"',
    });
  });
});

describe('withAdmissionGuard', () => {
  it('with no reader, delegates to the inner preflight unchanged', async () => {
    const inner = vi.fn(async () => ({ kind: 'adopt' as const, branch: 'b' }));
    const guard = withAdmissionGuard({ preflight: inner });
    const issue: QueueIssue = { number: 1, labels: [] };
    await expect(guard(issue)).resolves.toEqual({ kind: 'adopt', branch: 'b' });
    expect(inner).toHaveBeenCalledWith(issue);
  });

  it('with no reader and no inner preflight, defaults to build', async () => {
    const guard = withAdmissionGuard({});
    await expect(guard({ number: 1, labels: [] })).resolves.toEqual({ kind: 'build' });
  });

  it('a reader returning absent lets the inner preflight run', async () => {
    const inner = vi.fn(async () => ({ kind: 'build' as const }));
    const reader = { read: vi.fn(async () => ({ kind: 'absent' as const })) };
    const guard = withAdmissionGuard({ reader, preflight: inner });
    await expect(guard({ number: 1, labels: [] })).resolves.toEqual({ kind: 'build' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('a refusing verdict defers, calls onConflict once, and never runs the inner preflight', async () => {
    const inner = vi.fn(async () => ({ kind: 'build' as const }));
    const reader = {
      read: vi.fn(async () => ({ kind: 'record' as const, record: { issue: 1, state: 'executing' as const } })),
    };
    const onConflict = vi.fn();
    const guard = withAdmissionGuard({ reader, preflight: inner, onConflict });
    await expect(guard({ number: 1, labels: [] })).resolves.toEqual({ kind: 'defer' });
    expect(inner).not.toHaveBeenCalled();
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith(1, expect.objectContaining({ kind: 'refuse', state: 'executing' }));
  });

  it('a reader that throws defers with an unreadable verdict', async () => {
    const reader = {
      read: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const onConflict = vi.fn();
    const guard = withAdmissionGuard({ reader, onConflict });
    await expect(guard({ number: 1, labels: [] })).resolves.toEqual({ kind: 'defer' });
    expect(onConflict).toHaveBeenCalledWith(1, expect.objectContaining({ kind: 'refuse', state: 'unreadable' }));
  });

  it('integrates with the real queue: a conflicting candidate is skipped without any label mutation', async () => {
    const state = new Map<number, Set<string>>([[1, new Set(['factory:queued', 'factory:lane:x', 'factory:order:1'])]]);
    const calls: string[] = [];
    const client: QueueGitHubClient = {
      async listOpenIssuesWithLabels({ labels }) {
        calls.push('listOpenIssuesWithLabels');
        const result: QueueIssue[] = [];
        for (const [number, labelSet] of state) {
          if (labels.every((l) => labelSet.has(l))) result.push({ number, labels: [...labelSet] });
        }
        return result;
      },
      async getIssueLabels({ issue_number }) {
        calls.push('getIssueLabels');
        return [...(state.get(issue_number) ?? new Set<string>())];
      },
      async addLabels() {
        calls.push('addLabels');
      },
      async removeLabel() {
        calls.push('removeLabel');
      },
      async ensureLabel() {
        calls.push('ensureLabel');
      },
    };

    const reader = {
      read: async () => ({ kind: 'record' as const, record: { issue: 1, state: 'executing' as const } }),
    };
    const queue = createGithubQueue({
      client,
      owner: 'o',
      repo: 'r',
      preflight: withAdmissionGuard({ reader }),
    });

    await expect(queue.claimNext('x')).resolves.toBeNull();
    expect(calls).not.toContain('addLabels');
    expect(calls).not.toContain('removeLabel');
  });
});
