// packages/cli/src/cli/queue-startup.test.ts — the startup stale lane-claim sweep never throws (#3065)

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { getFactoryPaths } from '@on-par/factory-core';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reapExpiredClaims, sweepLaneClaims } from './queue-startup.js';

let dir: string;
let paths: ReturnType<typeof getFactoryPaths>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-queue-startup-'));
  paths = { events: join(dir, 'events.jsonl'), laneFiles: join(dir, 'lane-files') } as ReturnType<
    typeof getFactoryPaths
  >;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sweepLaneClaims', () => {
  it('skips the sweep and logs nothing when there is no GitHub token', async () => {
    await sweepLaneClaims(paths, 'o/r', () => undefined);
    await expect(readFile(paths.events, 'utf8')).rejects.toThrow();
  });

  it('logs a warn instead of throwing when the sweep fails', async () => {
    await expect(
      sweepLaneClaims(paths, 'o/r', () => {
        throw new Error('token store unreadable');
      }),
    ).resolves.toBeUndefined();
    expect(await readFile(paths.events, 'utf8')).toContain('lane claim sweep failed: token store unreadable');
  });

  it('releases a crash-left claim for a queued issue with no PR (holder-not-running)', async () => {
    const claim = { repo: 'o/r', issue: 247, files: ['StatusReport.swift'], claimedAt: '2026-10-18T06:53:00.000Z' };
    await writeFile(paths.laneFiles, JSON.stringify({ version: 1, claims: { 'o/r#247': claim } }));
    const rest = {
      issues: { get: async () => ({ data: { state: 'open', labels: ['factory:queued'], title: 'Status report' } }) },
      pulls: { list: async () => ({ data: [] }) },
    };
    const octokit: Octokit = Object.assign({} as Octokit, { rest });
    await sweepLaneClaims(paths, 'o/r', () => octokit);
    expect(JSON.parse(await readFile(paths.laneFiles, 'utf8')).claims).toEqual({});
    const events = await readFile(paths.events, 'utf8');
    expect(events).toContain('lane_file_claim_reaped');
    expect(events).toContain('holder-not-running');
  });
});

describe('reapExpiredClaims', () => {
  const octokit = {} as Octokit;
  const base = { issue: 3339, label: 'factory:claim-expires:1700000000', expiresAt: 1_700_000_000 };

  it('makes no call without an octokit', async () => {
    const release = vi.fn();
    await reapExpiredClaims(paths, 'o/r', () => undefined, release);
    expect(release).not.toHaveBeenCalled();
  });

  it('logs claim_expired_released for a released claim', async () => {
    const release = vi.fn(async () => [{ ...base, released: true, outcome: 'released' as const }]);
    await reapExpiredClaims(paths, 'o/r', () => octokit, release);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r' }));
    const events = await readFile(paths.events, 'utf8');
    expect(events).toContain('"type":"claim_expired_released"');
    expect(events).toContain('#3339 claim lease expired');
  });

  it('logs a warn for a failed release and nothing for a renewed one', async () => {
    const release = vi.fn(async () => [
      { ...base, released: false, outcome: 'failed' as const, detail: 'boom' },
      { ...base, issue: 1, released: false, outcome: 'renewed' as const },
    ]);
    await reapExpiredClaims(paths, 'o/r', () => octokit, release);
    const events = await readFile(paths.events, 'utf8');
    expect(events).toContain('expired claim release for #3339 failed: boom');
    expect(events).not.toContain('claim_expired_released');
  });

  it('reapExpiredClaims logs reap_refused_clock_skew when the reap is refused for clock skew', async () => {
    const refused = { released: false, outcome: 'refused-clock-skew' as const, skewMs: 300_000 };
    const release = vi.fn(async () => [
      { ...base, ...refused },
      { ...base, issue: 4, ...refused },
    ]);
    await reapExpiredClaims(paths, 'o/r', () => octokit, release);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ maxClockSkewMs: 60_000 }));
    const events = await readFile(paths.events, 'utf8');
    expect(events.match(/"type":"reap_refused_clock_skew"/g)).toHaveLength(1);
    expect(events).toContain('#3339, #4');
    expect(events).toContain('300000ms off GitHub');
    expect(events).not.toContain('claim_expired_released');
  });

  it('logs a warn and resolves when the release throws', async () => {
    const release = vi.fn(async () => {
      throw new Error('api down');
    });
    await expect(reapExpiredClaims(paths, 'o/r', () => octokit, release)).resolves.toBeUndefined();
    expect(await readFile(paths.events, 'utf8')).toContain('expired claim reap failed: api down');
  });
});
