import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { describeHostedJobStoreContract } from './store-contract.js';
import { resolveHostedJobStore } from './store-resolve.js';
import { createSqliteHostedJobStore } from './store-sqlite.js';

describeHostedJobStoreContract('sqlite', (options) => createSqliteHostedJobStore(options));

describe('createSqliteHostedJobStore restart durability (#939)', () => {
  const dirs: string[] = [];

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sf-store-'));
    dirs.push(dir);
    return join(dir, 'store.db');
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('keeps jobs, events, and runners intact across a close/reopen restart (AC#1)', () => {
    const databasePath = tempDbPath();
    const clock = 1_000;
    const store = createSqliteHostedJobStore({ now: () => clock, databasePath });

    store.create({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:write',
    });
    store.registerRunner({ runnerId: 'runner-1', capabilities: ['git'] });
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.heartbeat('job-1', 'lease-1');

    const preRestartJob = store.get('job-1');
    const preRestartRunner = store.getRunner('runner-1');
    store.close();

    const reopened = createSqliteHostedJobStore({ now: () => clock, databasePath });
    expect(reopened.get('job-1')).toEqual(preRestartJob);
    expect(reopened.get('job-1')?.events).toEqual(preRestartJob?.events);
    expect(reopened.getRunner('runner-1')).toEqual(preRestartRunner);
    expect(reopened.get('job-1')?.lease).not.toBeNull();
    reopened.close();
  });

  it('keeps terminal state immutable across a restart (AC#2)', () => {
    const databasePath = tempDbPath();
    const clock = 1_000;
    const store = createSqliteHostedJobStore({ now: () => clock, databasePath });

    store.create({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:write',
    });
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.complete('job-1', 'lease-1', 'done summary');
    store.close();

    const reopened = createSqliteHostedJobStore({ now: () => clock, databasePath });
    expect(reopened.get('job-1')?.request.status).toBe('done');
    const result = reopened.get('job-1')?.result;
    expect(result).toMatchObject({ outcome: 'completed', summary: 'done summary' });

    expect(
      reopened.acquireLease({
        jobId: 'job-1',
        runnerId: 'runner-2',
        leaseId: 'lease-2',
        ttlMs: 60_000,
        heartbeatIntervalMs: 5_000,
      }),
    ).toMatchObject({ ok: false, reason: 'job-terminal' });

    const staleComplete = reopened.complete('job-1', 'lease-1', 'late completion');
    expect(staleComplete).toMatchObject({ ok: true, alreadyTerminal: true });
    expect(reopened.get('job-1')?.result).toEqual(result);
    reopened.close();
  });

  it('keeps a live lease held across a restart until it expires (AC#3)', () => {
    const databasePath = tempDbPath();
    let clock = 1_000;
    const store = createSqliteHostedJobStore({ now: () => clock, databasePath });

    store.create({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:write',
    });
    store.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    store.close();

    const reopened = createSqliteHostedJobStore({ now: () => clock, databasePath });
    expect(
      reopened.acquireLease({
        jobId: 'job-1',
        runnerId: 'runner-2',
        leaseId: 'lease-2',
        ttlMs: 60_000,
        heartbeatIntervalMs: 5_000,
      }),
    ).toMatchObject({ ok: false, reason: 'lease-held' });
    reopened.close();

    clock += 61_000; // past expiresAt
    const reopenedAgain = createSqliteHostedJobStore({ now: () => clock, databasePath });
    const release = reopenedAgain.acquireLease({
      jobId: 'job-1',
      runnerId: 'runner-2',
      leaseId: 'lease-2',
      ttlMs: 60_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(release.ok).toBe(true);
    reopenedAgain.close();
  });

  it('bootstraps the schema idempotently via PRAGMA user_version', () => {
    const databasePath = tempDbPath();
    const store = createSqliteHostedJobStore({ now: () => 1_000, databasePath });
    store.create({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:write',
    });
    store.close();

    const reopened = createSqliteHostedJobStore({ now: () => 1_000, databasePath });
    expect(reopened.get('job-1')).toBeDefined();
    reopened.close();

    const raw = new DatabaseSync(databasePath);
    const row = raw.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(1);
    raw.close();
  });
});

describe('resolveHostedJobStore (#939)', () => {
  it('defaults to the memory backend when omitted', () => {
    const store = resolveHostedJobStore({ now: () => 1_000 });
    store.create({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:write',
    });
    expect(store.get('job-1')).toBeDefined();
    expect('close' in store).toBe(false);
  });

  it('defaults to the memory backend when explicitly requested', () => {
    const store = resolveHostedJobStore({ now: () => 1_000, backend: 'memory' });
    expect(store.list()).toEqual([]);
  });

  it('selects the sqlite backend and defaults databasePath to :memory:', () => {
    const store = resolveHostedJobStore({ now: () => 1_000, backend: 'sqlite' });
    store.create({
      jobId: 'job-1',
      repoSlug: 'on-par/software-factory',
      taskPayload: 'run the build',
      requiredCapabilities: ['git'],
      requiredAuthority: 'repo:write',
    });
    expect(store.get('job-1')).toBeDefined();
    store.close();
  });
});
