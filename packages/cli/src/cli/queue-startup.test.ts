// packages/cli/src/cli/queue-startup.test.ts — the startup stale lane-claim sweep never throws (#3065)

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { getFactoryPaths } from '@on-par/factory-core';
import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sweepLaneClaims } from './queue-startup.js';

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
