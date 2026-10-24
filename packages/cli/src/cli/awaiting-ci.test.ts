// packages/cli/src/cli/awaiting-ci.test.ts — awaiting-ci record store, backoff schedule and re-check runner (#3208)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  awaitingCiFile,
  createAwaitingCiLaneDeps,
  defaultAwaitingCiVerdict,
  type AwaitingCiRecheckDeps,
  type AwaitingCiVerdict,
  nextRecheckAt,
  readAwaitingCi,
  recordAwaitingCi,
  runAwaitingCiRechecks,
} from './awaiting-ci.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-17T00:00:00Z');
const rec = { issue: 7, prNumber: 70, headSha: 'a'.repeat(40), branch: 'ship-it/7-x' };

describe('awaiting-ci', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awaiting-ci-'));
    file = join(dir, 'awaiting-ci.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const harness = (over: Partial<AwaitingCiRecheckDeps> & { verdicts?: AwaitingCiVerdict[] } = {}) => {
    let now = T0;
    const calls = { verdict: [] as string[], merge: [] as string[], log: [] as string[] };
    const queue = [...(over.verdicts ?? [])];
    const deps: AwaitingCiRecheckDeps = {
      file,
      nowMs: () => now,
      capMs: 24 * HOUR,
      getPr: async () => ({ state: 'open', merged: false, headSha: 'b'.repeat(40) }),
      verdict: async (sha) => {
        calls.verdict.push(sha);
        return queue.shift() ?? 'pending';
      },
      merge: async (_r, sha) => {
        calls.merge.push(sha);
      },
      log: (type, _issue, msg) => calls.log.push(`${type}: ${msg}`),
      ...over,
    };
    return { deps, calls, at: (ms: number) => (now = T0 + ms) };
  };

  it.each([
    [0, 2 * MIN],
    [1, 5 * MIN],
    [2, 15 * MIN],
    [3, 45 * MIN],
    [4, 75 * MIN],
    [5, 105 * MIN],
  ])('re-check %i is due %i ms after first seen', (rechecks, offset) => {
    expect(nextRecheckAt(T0, rechecks)).toBe(T0 + offset);
  });

  it('upserts one record per issue and treats a malformed file as empty', () => {
    recordAwaitingCi(file, rec, T0);
    const second = recordAwaitingCi(file, { ...rec, headSha: 'c'.repeat(40) }, T0 + MIN);
    expect(readAwaitingCi(file)).toEqual([second]);
    expect(second.nextRecheckAt).toBe(new Date(T0 + 3 * MIN).toISOString());
    writeFileSync(file, '{not json');
    const seen: string[] = [];
    expect(readAwaitingCi(file, (d) => seen.push(d))).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(readAwaitingCi(join(dir, 'missing.json'))).toEqual([]);
  });

  it.each([
    ['merged', { state: 'closed', merged: true }],
    ['closed', { state: 'closed', merged: false }],
  ])('clears the record of a PR that is already %s', async (_n, pr) => {
    recordAwaitingCi(file, rec, T0);
    const h = harness({ getPr: async () => ({ ...pr, headSha: rec.headSha }) });
    h.at(2 * MIN);
    expect(await runAwaitingCiRechecks(h.deps)).toEqual([{ action: 'cleared', issue: 7, prNumber: 70 }]);
    expect(readAwaitingCi(file)).toEqual([]);
    expect(h.calls.verdict).toEqual([]);
  });

  it('parks a failed verdict as ci-failed and clears the record', async () => {
    recordAwaitingCi(file, rec, T0);
    const h = harness({ verdicts: ['failed'] });
    h.at(2 * MIN);
    const [r] = await runAwaitingCiRechecks(h.deps);
    expect(r).toMatchObject({ action: 'parked', reason: 'ci-failed', issue: 7, branch: rec.branch });
    expect(readAwaitingCi(file)).toEqual([]);
  });

  it('merges pinned to the current head SHA and clears the record when a late required check succeeds', async () => {
    recordAwaitingCi(file, rec, T0);
    const h = harness({ verdicts: ['green'] });
    h.at(3 * HOUR);
    expect(await runAwaitingCiRechecks(h.deps)).toEqual([{ action: 'merged', issue: 7, prNumber: 70 }]);
    expect(h.calls.merge).toEqual(['b'.repeat(40)]);
    expect(readAwaitingCi(file)).toEqual([]);
    expect(h.calls.log.at(-1)).toMatch(/^landed:/);
  });

  it('does not merge a green PR when auto-merge is off, and reschedules it', async () => {
    recordAwaitingCi(file, rec, T0);
    const h = harness({ verdicts: ['green'], mergeEnabled: () => false });
    h.at(2 * MIN);
    expect(await runAwaitingCiRechecks(h.deps)).toEqual([{ action: 'rescheduled', issue: 7, prNumber: 70 }]);
    expect(h.calls.merge).toEqual([]);
  });

  it('reschedules and keeps the head SHA current when the merge is refused', async () => {
    recordAwaitingCi(file, rec, T0);
    const h = harness({
      verdicts: ['green'],
      merge: async () => {
        throw new Error('Head branch was modified');
      },
    });
    h.at(2 * MIN);
    expect((await runAwaitingCiRechecks(h.deps)).map((r) => r.action)).toEqual(['rescheduled']);
    expect(readAwaitingCi(file)[0]).toMatchObject({ rechecks: 1 });
    expect(h.calls.log.some((l) => l.startsWith('warn:'))).toBe(true);
  });

  it('parks a still-pending PR as ci-never-started once it is at the cap', async () => {
    recordAwaitingCi(file, rec, T0);
    const h = harness({ capMs: 2 * HOUR });
    h.at(2 * HOUR - MIN);
    expect((await runAwaitingCiRechecks(h.deps)).map((r) => r.action)).toEqual(['rescheduled']);
    h.at(2 * HOUR + 30 * MIN);
    const [r] = await runAwaitingCiRechecks(h.deps);
    expect(r).toMatchObject({ action: 'parked', reason: 'ci-never-started' });
    expect(readFileSync(file, 'utf8')).not.toContain('"issue": 7');
    expect(h.calls.log.at(-1)).toMatch(/^ci-never-started: PR #70 on b+: no CI run ever registered after 2\.\d hours/);
  });

  const fakeOctokit = (runs: any[], pr: any = {}) =>
    ({
      rest: {
        checks: { listForRef: async () => ({ data: { check_runs: runs } }) },
        repos: {
          getStatusChecksProtection: async () => ({ data: { contexts: ['verify'] } }),
          getBranchRules: async () => ({ data: [] }),
        },
        pulls: {
          get: async () => ({
            data: { state: 'open', merged: false, head: { sha: 'c'.repeat(40) }, base: { ref: 'main' }, ...pr },
          }),
          merge: vi.fn(async () => ({})),
        },
        git: { deleteRef: async () => ({}) },
      },
    }) as any;

  it('maps a watchChecks pass on the head SHA to green, failed or pending', async () => {
    const verdictFor = (runs: any[]) => defaultAwaitingCiVerdict(fakeOctokit(runs), 'o', 'r', 'main')('d'.repeat(40));
    expect(await verdictFor([{ name: 'verify', status: 'completed', conclusion: 'success' }])).toBe('green');
    expect(await verdictFor([{ name: 'verify', status: 'completed', conclusion: 'failure' }])).toBe('failed');
  });

  it('wires lane deps: records through the file and merges a green PR pinned to its head', async () => {
    const octokit = fakeOctokit([{ name: 'verify', status: 'completed', conclusion: 'success' }]);
    const log = vi.fn();
    let now = T0;
    const lane = createAwaitingCiLaneDeps({
      file: awaitingCiFile({ state: dir }),
      octokit,
      ghRepo: 'o/r',
      capMs: 24 * HOUR,
      admin: false,
      mergeEnabled: true,
      log,
      nowMs: () => now,
    });
    await lane.recordAwaitingCi(rec);
    expect(await lane.recheckAwaitingCi()).toEqual([]);
    now = T0 + 3 * HOUR;
    expect(await lane.recheckAwaitingCi()).toEqual([{ action: 'merged', issue: 7, prNumber: 70 }]);
    expect(octokit.rest.pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 70, sha: 'c'.repeat(40) }),
    );
    expect(readAwaitingCi(file)).toEqual([]);
  });

  it('warns once about the no-protection fallback and logs an unreadable state file during a re-check', async () => {
    const octokit = fakeOctokit([{ name: 'lint', status: 'completed', conclusion: 'success' }]);
    octokit.rest.repos.getStatusChecksProtection = async () => ({ data: { contexts: [] } });
    const warn = vi.fn();
    vi.useFakeTimers();
    try {
      const verdict = defaultAwaitingCiVerdict(
        octokit,
        'o',
        'unprotected-for-awaiting-ci',
        'main',
        warn,
      )('d'.repeat(40));
      await vi.runAllTimersAsync();
      expect(await verdict).toBe('green');
    } finally {
      vi.useRealTimers();
    }
    expect(warn).toHaveBeenCalledWith(
      'no branch protection on o/unprotected-for-awaiting-ci@main; using all checks on head',
    );

    writeFileSync(file, '[oops');
    const h = harness();
    expect(await runAwaitingCiRechecks(h.deps)).toEqual([]);
    expect(h.calls.log[0]).toMatch(/^warn: awaiting-ci state file .* is unreadable/);
  });
});
