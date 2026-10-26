// packages/cli/src/cli/doctor-queue-reconcile.test.ts — reconcileQueue's fleet.leader gate for blocked-park polling (#3147).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileQueue } from './doctor-queue-reconcile.js';

describe('reconcileQueue fleet.leader gate', () => {
  let dir: string;
  let log: { mock: { calls: unknown[][] }; mockRestore: () => void };
  const octokit = {} as Octokit;
  const ops = () => ({
    releaseStaleClaims: vi.fn(async () => []),
    pollBlockedParks: vi.fn(async (_opts: unknown) => []),
  });
  const logged = (): string => log.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('FACTORY_HOST_ID', 'host-b');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints a skip line and does not poll when this host is not the leader', async () => {
    const o = ops();
    await reconcileQueue(o as never, 'o/r', octokit, join(dir, 'events.ndjson'), undefined, 'host-a');
    expect(o.pollBlockedParks).not.toHaveBeenCalled();
    expect(logged()).toContain('reconcile: skipping blocked parks: this host (host-b) is not fleet.leader (host-a)');
  });

  it('polls and passes the leader and host id when this host is the leader', async () => {
    const o = ops();
    await reconcileQueue(o as never, 'o/r', octokit, join(dir, 'events.ndjson'), undefined, 'host-b');
    expect(o.pollBlockedParks).toHaveBeenCalledWith(
      expect.objectContaining({ fleetLeader: 'host-b', hostId: 'host-b' }),
    );
  });

  it('polls when no leader is set and records order_collision_repaired as a warn event', async () => {
    const o = ops();
    const eventsFile = join(dir, 'events.ndjson');
    await reconcileQueue(o as never, 'o/r', octokit, eventsFile);
    const { logEvent } = o.pollBlockedParks.mock.calls[0][0] as {
      logEvent: (kind: string, issue: number, msg: string) => void;
    };
    logEvent('order_collision_repaired', 5, 'lane build: order 1 shared; kept #2, moved #5 → 2');
    const line = JSON.parse(readFileSync(eventsFile, 'utf8').trim());
    expect(line).toMatchObject({ type: 'order_collision_repaired', level: 'warn' });
  });
});
