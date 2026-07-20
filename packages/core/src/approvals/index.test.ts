import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ApprovalRequest,
  createFileApprovalGate,
  listPendingApprovals,
  PLAN_SPEC_PREVIEW_BYTES,
  respondToApproval,
} from './index.js';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'approvals-'));
}

async function waitFor<T>(check: () => T | undefined, tries = 40, delayMs = 5): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('waitFor: condition never became truthy');
}

describe('createFileApprovalGate', () => {
  it('writes a request file with issue/branch/diffStat/checkSummary and an ISO requestedAt', async () => {
    const dir = makeDir();
    try {
      const gate = createFileApprovalGate({ dir, timeoutMs: 500, pollMs: 10 });
      const promise = gate({
        issue: 42,
        branch: 'ship-it/42-thing',
        worktree: '/tmp/wt',
        diffStat: ' 1 file changed\n',
        checkSummary: { failures: 0, passes: 3, skips: 0, total: 3, results: [] },
      });

      const request = await waitFor<ApprovalRequest>(() => {
        const files = readdirSync(dir).filter((f) => f.endsWith('.request.json'));
        return files.length > 0 ? JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) : undefined;
      });

      expect(request).toMatchObject({
        issue: 42,
        branch: 'ship-it/42-thing',
        worktree: '/tmp/wt',
        diffStat: ' 1 file changed\n',
        checkSummary: { failures: 0, passes: 3, skips: 0, total: 3, results: [] },
      });
      expect(request.id).toEqual(expect.any(String));
      expect(new Date(request.requestedAt).toISOString()).toBe(request.requestedAt);

      respondToApproval(dir, request.id, { approved: true });
      await expect(promise).resolves.toMatchObject({ id: request.id, approved: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves approved when a valid response file appears', async () => {
    const dir = makeDir();
    try {
      const gate = createFileApprovalGate({ dir, timeoutMs: 500, pollMs: 10 });
      const promise = gate({ issue: 1, branch: 'b', worktree: '/w', diffStat: '' });

      setTimeout(() => {
        const files = readdirSync(dir).filter((f) => f.endsWith('.request.json'));
        const id = files[0].replace('.request.json', '');
        respondToApproval(dir, id, { approved: true });
      }, 20);

      const response = await promise;
      expect(response.approved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves denied with a timed-out reason when no response arrives within timeoutMs, and never hangs', async () => {
    const dir = makeDir();
    try {
      const gate = createFileApprovalGate({ dir, timeoutMs: 50, pollMs: 10 });
      const response = await gate({ issue: 1, branch: 'b', worktree: '/w', diffStat: '' });
      expect(response.approved).toBe(false);
      expect(response.reason).toMatch(/timed out/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a deny reason written by a separate responder ("another process")', async () => {
    const dir = makeDir();
    try {
      const gate = createFileApprovalGate({ dir, timeoutMs: 500, pollMs: 10 });
      const promise = gate({ issue: 7, branch: 'b7', worktree: '/w', diffStat: '' });

      const pending = await waitFor<ApprovalRequest[]>(() => {
        const list = listPendingApprovals(dir);
        return list.length > 0 ? list : undefined;
      });
      expect(pending).toHaveLength(1);
      respondToApproval(dir, pending[0].id, { approved: false, reason: 'not ready' });

      const response = await promise;
      expect(response).toMatchObject({ approved: false, reason: 'not ready' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a kind:"plan" request with a specPreview', async () => {
    const dir = makeDir();
    try {
      const gate = createFileApprovalGate({ dir, timeoutMs: 500, pollMs: 10 });
      const promise = gate({
        issue: 51,
        branch: 'ship-it/51-thing',
        worktree: '/tmp/wt',
        diffStat: '',
        kind: 'plan',
        specPreview: '# Frozen spec',
      });

      const request = await waitFor<ApprovalRequest>(() => {
        const files = readdirSync(dir).filter((f) => f.endsWith('.request.json'));
        return files.length > 0 ? JSON.parse(readFileSync(join(dir, files[0]), 'utf-8')) : undefined;
      });

      expect(request.kind).toBe('plan');
      expect(request.specPreview).toBe('# Frozen spec');

      respondToApproval(dir, request.id, { approved: true });
      await expect(promise).resolves.toMatchObject({ id: request.id, approved: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PLAN_SPEC_PREVIEW_BYTES', () => {
  it('is exported as a positive number', () => {
    expect(typeof PLAN_SPEC_PREVIEW_BYTES).toBe('number');
    expect(PLAN_SPEC_PREVIEW_BYTES).toBeGreaterThan(0);
  });
});

describe('respondToApproval', () => {
  it('writes atomically (no .tmp file left behind) and returns the response', () => {
    const dir = makeDir();
    try {
      const response = respondToApproval(dir, 'abc', { approved: true });
      expect(response.id).toBe('abc');
      expect(response.approved).toBe(true);
      expect(readFileSync(join(dir, 'abc.response.json'), 'utf-8')).toContain('"approved": true');
      expect(readdirSync(dir)).not.toContain('abc.response.json.tmp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('listPendingApprovals', () => {
  it('returns [] when the directory does not exist', () => {
    expect(listPendingApprovals(join(tmpdir(), 'approvals-does-not-exist-xyz'))).toEqual([]);
  });

  it('excludes answered requests, skips malformed JSON, and sorts oldest first', () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, 'newer.request.json'),
        JSON.stringify({
          issue: 2,
          branch: 'b2',
          worktree: '/w',
          diffStat: '',
          requestedAt: '2024-01-02T00:00:00.000Z',
        }),
      );
      writeFileSync(
        join(dir, 'older.request.json'),
        JSON.stringify({
          issue: 1,
          branch: 'b1',
          worktree: '/w',
          diffStat: '',
          requestedAt: '2024-01-01T00:00:00.000Z',
        }),
      );
      writeFileSync(
        join(dir, 'answered.request.json'),
        JSON.stringify({
          issue: 3,
          branch: 'b3',
          worktree: '/w',
          diffStat: '',
          requestedAt: '2024-01-01T12:00:00.000Z',
        }),
      );
      writeFileSync(
        join(dir, 'answered.response.json'),
        JSON.stringify({ id: 'answered', approved: true, respondedAt: '2024-01-01T13:00:00.000Z' }),
      );
      writeFileSync(join(dir, 'broken.request.json'), '{not json');

      const pending = listPendingApprovals(dir);
      expect(pending.map((r) => r.id)).toEqual(['older', 'newer']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
