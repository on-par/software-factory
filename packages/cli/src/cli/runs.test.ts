import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRunsJson, parseRunsLimit } from './runs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-runs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeRun = (n: number, updatedAt: string, extra: Record<string, unknown> = {}): void => {
  writeFileSync(
    join(dir, `issue-${n}.json`),
    JSON.stringify({
      issue: n,
      lane: 'daw',
      repo: 'o/r',
      status: 'running',
      branch: `factory/${n}`,
      worktree: '/w',
      specPath: '/s',
      model: 'm',
      route: 'claude',
      attempts: 2,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt,
      ...extra,
    }),
  );
};
const writePhase = (n: number, updatedAt: string): void => {
  writeFileSync(
    join(dir, `issue-${n}.phase.json`),
    JSON.stringify({ issue: n, phase: 'build', updatedAt, lastActivityAt: updatedAt }),
  );
};

describe('buildRunsJson', () => {
  it('returns runs newest first with the full row shape', async () => {
    writeRun(1, '2026-01-01T00:00:00Z');
    writeRun(2, '2026-01-03T00:00:00Z', { prNumber: 42 });
    writeRun(3, '2026-01-02T00:00:00Z');

    const { json, skipped } = await buildRunsJson(dir);

    expect(skipped).toEqual([]);
    expect(json.runs.map((r) => r.issue)).toEqual([2, 3, 1]);
    expect(json.runs[0]).toEqual({
      issue: 2,
      lane: 'daw',
      repo: 'o/r',
      status: 'running',
      phase: null,
      branch: 'factory/2',
      prNumber: 42,
      model: 'm',
      attempts: 2,
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    });
  });

  it('honors limit', async () => {
    writeRun(1, '2026-01-01T00:00:00Z');
    writeRun(2, '2026-01-03T00:00:00Z');
    const { json } = await buildRunsJson(dir, { limit: 1 });
    expect(json.runs.map((r) => r.issue)).toEqual([2]);
  });

  it('gives prNumber null when there is no PR', async () => {
    writeRun(1, '2026-01-01T00:00:00Z');
    const { json } = await buildRunsJson(dir);
    expect(json.runs[0]?.prNumber).toBeNull();
  });

  it('returns an empty list for a missing dir', async () => {
    expect(await buildRunsJson(join(dir, 'nope'))).toEqual({ json: { schemaVersion: 1, runs: [] }, skipped: [] });
  });

  it('rethrows non-ENOENT read errors', async () => {
    writeFileSync(join(dir, 'file'), '');
    await expect(buildRunsJson(join(dir, 'file'))).rejects.toThrow();
  });

  it('skips a malformed run file and notes it', async () => {
    writeRun(1, '2026-01-01T00:00:00Z');
    writeFileSync(join(dir, 'issue-9.json'), '{not json');
    const { json, skipped } = await buildRunsJson(dir);
    expect(json.runs.map((r) => r.issue)).toEqual([1]);
    expect(skipped).toEqual(['factory: runs — skipped malformed issue-9.json']);
  });

  it('skips a run file without a string updatedAt', async () => {
    writeFileSync(join(dir, 'issue-4.json'), JSON.stringify({ issue: 4 }));
    const { json, skipped } = await buildRunsJson(dir);
    expect(json.runs).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it('builds a row from a phase-only issue', async () => {
    mkdirSync(dir, { recursive: true });
    writePhase(5, '2026-02-01T00:00:00Z');
    const { json } = await buildRunsJson(dir);
    expect(json.runs).toEqual([
      {
        issue: 5,
        lane: null,
        repo: null,
        status: null,
        phase: 'build',
        branch: null,
        prNumber: null,
        model: null,
        attempts: null,
        startedAt: null,
        updatedAt: '2026-02-01T00:00:00Z',
      },
    ]);
  });

  it('merges run state and phase snapshot, taking the later updatedAt', async () => {
    writeRun(6, '2026-01-01T00:00:00Z');
    writePhase(6, '2026-01-05T00:00:00Z');
    writeRun(7, '2026-01-09T00:00:00Z');
    writePhase(7, '2026-01-05T00:00:00Z');
    const { json } = await buildRunsJson(dir);
    const by = new Map(json.runs.map((r) => [r.issue, r]));
    expect(by.get(6)).toMatchObject({ phase: 'build', lane: 'daw', updatedAt: '2026-01-05T00:00:00Z' });
    expect(by.get(7)?.updatedAt).toBe('2026-01-09T00:00:00Z');
  });

  it('notes a malformed phase file and ignores unrelated names', async () => {
    writeRun(3, '2026-01-01T00:00:00Z');
    writeFileSync(join(dir, 'issue-3.phase.json'), 'nope');
    writeFileSync(join(dir, 'issue-3.json.tmp'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const { json, skipped } = await buildRunsJson(dir);
    expect(json.runs.map((r) => r.issue)).toEqual([3]);
    expect(skipped).toEqual(['factory: runs — skipped malformed issue-3.phase.json']);
  });

  it('breaks updatedAt ties by issue number descending', async () => {
    writeRun(1, '2026-01-01T00:00:00Z');
    writeRun(8, '2026-01-01T00:00:00Z');
    writeRun(4, '2026-01-01T00:00:00Z');
    const { json } = await buildRunsJson(dir);
    expect(json.runs.map((r) => r.issue)).toEqual([8, 4, 1]);
  });

  it('nulls wrong-typed fields and sorts unparsable timestamps last', async () => {
    writeRun(1, 'garbage', { prNumber: 'x', attempts: 'y', lane: 3 });
    writeRun(2, '2026-01-01T00:00:00Z');
    const { json } = await buildRunsJson(dir);
    expect(json.runs.map((r) => r.issue)).toEqual([2, 1]);
    expect(json.runs[1]).toMatchObject({ prNumber: null, attempts: null, lane: null });
  });
});

describe('parseRunsLimit', () => {
  it('defaults to 50 and parses positive integers', () => {
    expect(parseRunsLimit(undefined)).toBe(50);
    expect(parseRunsLimit('3')).toBe(3);
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects %s', (raw) => {
    expect(() => parseRunsLimit(raw)).toThrow(/invalid --limit/);
  });
});
