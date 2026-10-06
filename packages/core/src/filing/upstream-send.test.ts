import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateIssue } from './index.js';
import { buildUpstreamReport, upstreamReportMarker } from './upstream.js';
import {
  classifyUpstreamSendError,
  defaultUpstreamLedgerPath,
  defaultUpstreamOutboxDir,
  type PendingUpstreamReport,
  sendUpstreamReports,
  type UpstreamOutboxEntry,
  writeUpstreamOutbox,
} from './upstream-send.js';

function pending(fingerprint: string): PendingUpstreamReport {
  return {
    fingerprint,
    report: buildUpstreamReport({
      factoryVersion: '1.0.0',
      factoryCommit: 'abc1234',
      phase: 'build',
      reason: 'unknown',
      component: 'claude',
      fingerprint,
      error: { name: 'TypeError', message: 'boom' },
      frames: [],
      harness: null,
      model: 'm',
      os: 'darwin',
      nodeVersion: 'v22',
      redaction: {},
    }),
  };
}

const policy = { enabled: true, maxPerRun: 5, maxPerDay: 10 };
const day1 = () => new Date('2026-01-01T10:00:00Z');
const day2 = () => new Date('2026-01-02T10:00:00Z');

let dir: string;
let ledgerFile: string;
let outboxDir: string;
let logs: Array<{ level: string; type: string; msg: string }>;
const logger = {
  info: (type: string, msg: string) => void logs.push({ level: 'info', type, msg }),
  warn: (type: string, msg: string) => void logs.push({ level: 'warn', type, msg }),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'upstream-send-'));
  ledgerFile = join(dir, 'ledger.json');
  outboxDir = join(dir, 'outbox');
  logs = [];
});

function base(over: Record<string, unknown> = {}) {
  return { ledgerFile, outboxDir, logger, now: day1, policy, ...over };
}

interface CreateArg {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}
const okClient = () => ({
  createIssue: vi.fn(async (_a: CreateArg) => ({ number: 7 })),
  searchIssues: vi.fn(async (_a: { owner: string; repo: string; text: string }): Promise<CandidateIssue[]> => []),
  commentIssue: vi.fn(async (_a: { owner: string; repo: string; issue_number: number; body: string }) => {}),
  updateIssue: vi.fn(),
});

describe('sendUpstreamReports', () => {
  it('creates one issue with no labels', async () => {
    const client = okClient();
    const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_1')], client });
    expect(res).toEqual([{ fingerprint: 'ff_1', outcome: 'created', issueNumber: 7 }]);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const arg = client.createIssue.mock.calls[0]?.[0] as CreateArg;
    expect(arg.owner).toBe('on-par');
    expect(arg.repo).toBe('software-factory');
    expect(arg.title.startsWith('[factory-report]')).toBe(true);
    expect(arg.body).toContain(upstreamReportMarker('ff_1'));
    expect(arg.labels).toEqual([]);
    expect(logs.some((l) => l.type === 'upstream_report_sent')).toBe(true);
    await expect(readdir(outboxDir)).rejects.toThrow();
  });

  it('outboxes on 403 without counting against the cap', async () => {
    const err = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    const client = { ...okClient(), createIssue: vi.fn().mockRejectedValue(err) };
    const p = pending('ff_2');
    const res = await sendUpstreamReports({ ...base(), reports: [p], client });
    expect(res[0]?.outcome).toBe('outboxed');
    expect(res[0]?.reason).toBe('forbidden (403)');
    const entry = JSON.parse(await readFile(join(outboxDir, 'ff_2.json'), 'utf8')) as UpstreamOutboxEntry;
    expect(entry.title).toBe(p.report.title);
    expect(entry.body).toBe(p.report.body);
    expect(logs.find((l) => l.type === 'upstream_report_outboxed')?.msg).toContain('forbidden (403)');
    await expect(readFile(ledgerFile, 'utf8')).rejects.toThrow();
  });

  it('outboxes with no-auth when the client is null', async () => {
    const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_3')], client: null });
    expect(res[0]).toMatchObject({ outcome: 'outboxed', reason: 'no-auth' });
  });

  it('outboxes on a network error without status', async () => {
    const client = { ...okClient(), createIssue: vi.fn().mockRejectedValue(new Error('ECONNRESET')) };
    const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_4')], client });
    expect(res[0]?.outcome).toBe('outboxed');
    expect(res[0]?.reason).toMatch(/^send-failed/);
  });

  it('enforces the per-run cap without outboxing', async () => {
    const client = okClient();
    const res = await sendUpstreamReports({
      ...base({ policy: { ...policy, maxPerRun: 1 } }),
      reports: [pending('a'), pending('b')],
      client,
    });
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(res[1]).toMatchObject({ outcome: 'skipped', reason: 'per-run-cap' });
    await expect(readdir(outboxDir)).rejects.toThrow();
  });

  it('enforces the per-day cap across calls and rolls over', async () => {
    const client = okClient();
    const p = { ...policy, maxPerDay: 1 };
    await sendUpstreamReports({ ...base({ policy: p }), reports: [pending('a')], client });
    const second = await sendUpstreamReports({ ...base({ policy: p }), reports: [pending('b')], client });
    expect(second[0]).toMatchObject({ outcome: 'skipped', reason: 'per-day-cap' });
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    await sendUpstreamReports({ ...base({ policy: p, now: day2 }), reports: [pending('c')], client });
    expect(client.createIssue).toHaveBeenCalledTimes(2);
  });

  it('resets filedThisRun on each call', async () => {
    const client = okClient();
    const p = { ...policy, maxPerRun: 1 };
    await sendUpstreamReports({ ...base({ policy: p }), reports: [pending('a')], client });
    await sendUpstreamReports({ ...base({ policy: p }), reports: [pending('b')], client });
    expect(client.createIssue).toHaveBeenCalledTimes(2);
  });

  it('sends a repeated fingerprint once', async () => {
    const client = okClient();
    const res = await sendUpstreamReports({ ...base(), reports: [pending('a'), pending('a')], client });
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    expect(res[1]).toMatchObject({ outcome: 'skipped', reason: 'duplicate-in-run' });
  });

  it('skips everything when disabled', async () => {
    const client = okClient();
    const res = await sendUpstreamReports({
      ...base({ policy: { ...policy, enabled: false } }),
      reports: [pending('a'), pending('b')],
      client,
    });
    expect(res.map((r) => r.reason)).toEqual(['filing-disabled', 'filing-disabled']);
    expect(client.createIssue).not.toHaveBeenCalled();
    await expect(readdir(outboxDir)).rejects.toThrow();
    await expect(readFile(ledgerFile, 'utf8')).rejects.toThrow();
  });

  it('treats a corrupt ledger as empty', async () => {
    await writeFile(ledgerFile, 'not json');
    const client = okClient();
    const res = await sendUpstreamReports({ ...base(), reports: [pending('a')], client });
    expect(res[0]?.outcome).toBe('created');
  });

  it('survives an outbox write failure', async () => {
    const blocker = join(dir, 'file');
    await writeFile(blocker, 'x');
    const res = await sendUpstreamReports({ ...base({ outboxDir: blocker }), reports: [pending('a')], client: null });
    expect(res[0]?.outcome).toBe('outboxed');
    expect(res[0]?.outboxPath).toBeUndefined();
    expect(logs.find((l) => l.type === 'upstream_report_outboxed')?.msg).toContain('outbox write failed');
  });

  it('works without a logger and with default repo/paths helpers', async () => {
    const res = await sendUpstreamReports({
      reports: [pending('a')],
      client: okClient(),
      policy,
      ledgerFile,
      outboxDir,
    });
    expect(res[0]?.outcome).toBe('created');
    expect(defaultUpstreamOutboxDir('/h')).toBe(join('/h', '.factory', 'filing', 'outbox'));
    expect(defaultUpstreamLedgerPath('/h')).toBe(join('/h', '.factory', 'filing', 'upstream-ledger.json'));
  });
});

describe('classifyUpstreamSendError', () => {
  it.each([
    [{ status: 401 }, 'unauthorized (401)'],
    [{ status: 403 }, 'forbidden (403)'],
    [{ status: 404 }, 'not-found-or-no-access (404)'],
    [{ status: 410 }, 'issues-disabled (410)'],
    [{ status: 500 }, 'http-500'],
    [new Error('line one\nline two'), 'send-failed: line one'],
    ['nope', 'send-failed'],
    [null, 'send-failed'],
  ])('%j -> %s', (err, expected) => {
    expect(classifyUpstreamSendError(err)).toBe(expected);
  });
});

describe('writeUpstreamOutbox', () => {
  it('uses a safe file name for an invalid fingerprint', async () => {
    const path = await writeUpstreamOutbox(outboxDir, {
      version: 1,
      fingerprint: '../x',
      repo: 'on-par/software-factory',
      title: 't',
      body: 'b',
      reason: 'r',
      createdAt: day1().toISOString(),
    });
    expect(path.startsWith(outboxDir)).toBe(true);
    expect(path).toMatch(/invalid-\d+\.json$/);
  });

  describe('marker dedup (#1861)', () => {
    const existing = (fp: string, state: 'open' | 'closed' = 'open'): CandidateIssue => ({
      number: 42,
      body: pending(fp).report.body,
      state,
    });

    it('comments on a matching unlabeled issue and never edits or creates', async () => {
      const client = okClient();
      client.searchIssues.mockResolvedValue([existing('ff_1')]);
      const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_1')], client });
      expect(res).toEqual([{ fingerprint: 'ff_1', outcome: 'bumped', issueNumber: 42 }]);
      expect(client.searchIssues).toHaveBeenCalledWith({ owner: 'on-par', repo: 'software-factory', text: 'ff_1' });
      expect(client.commentIssue).toHaveBeenCalledTimes(1);
      expect(client.commentIssue.mock.calls[0]?.[0]).toMatchObject({ issue_number: 42 });
      expect(client.createIssue).not.toHaveBeenCalled();
      expect(client.updateIssue).not.toHaveBeenCalled();
      expect(logs.some((l) => l.type === 'upstream_report_bumped')).toBe(true);
    });

    it('bumps a recently closed match', async () => {
      const client = okClient();
      client.searchIssues.mockResolvedValue([existing('ff_1', 'closed')]);
      const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_1')], client });
      expect(res[0]).toMatchObject({ outcome: 'bumped', issueNumber: 42 });
      expect(client.createIssue).not.toHaveBeenCalled();
    });

    it('creates when the hit has the fingerprint but not the marker', async () => {
      const client = okClient();
      client.searchIssues.mockResolvedValue([{ number: 5, body: 'ff_1 <!-- fp:ff_1 -->', state: 'open' }]);
      const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_1')], client });
      expect(res[0]).toMatchObject({ outcome: 'created' });
    });

    it('skips search for an invalid fingerprint and creates', async () => {
      const client = okClient();
      const res = await sendUpstreamReports({ ...base(), reports: [pending('bad fp!')], client });
      expect(client.searchIssues).not.toHaveBeenCalled();
      expect(res[0]).toMatchObject({ outcome: 'created' });
    });

    it('outboxes when search fails', async () => {
      const client = okClient();
      client.searchIssues.mockRejectedValue({ status: 403 });
      const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_1')], client });
      expect(res[0]?.outcome).toBe('outboxed');
      expect(res[0]?.reason).toMatch(/^search-failed: forbidden \(403\)/);
      expect(client.createIssue).not.toHaveBeenCalled();
    });

    it('outboxes when the comment fails', async () => {
      const client = okClient();
      client.searchIssues.mockResolvedValue([existing('ff_1')]);
      client.commentIssue.mockRejectedValue({ status: 500 });
      const res = await sendUpstreamReports({ ...base(), reports: [pending('ff_1')], client });
      expect(res[0]?.outcome).toBe('outboxed');
      expect(res[0]?.reason).toMatch(/^comment-failed:/);
      expect(client.createIssue).not.toHaveBeenCalled();
    });

    it('does not consume caps on a bump', async () => {
      const client = okClient();
      client.searchIssues.mockImplementation(async ({ text }) => (text === 'a' ? [existing('a')] : []));
      const res = await sendUpstreamReports({
        ...base({ policy: { ...policy, maxPerRun: 1 } }),
        reports: [pending('a'), pending('b')],
        client,
      });
      expect(res.map((r) => r.outcome)).toEqual(['bumped', 'created']);
    });
  });
});
