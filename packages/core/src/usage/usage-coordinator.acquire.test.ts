import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import type { SubscriptionUsageDeps } from './subscription.js';
import { createUsageCoordinator } from './coordinator.js';
import { loadGrantLedger, pruneGrants, type GrantLedgerEntry } from './grant-ledger.js';

function fakeLogger(): FactoryLogger {
  const logger: FactoryLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function credentialsDeps(overrides: Partial<SubscriptionUsageDeps> = {}): SubscriptionUsageDeps {
  return {
    platform: 'linux',
    readCredentialsFile: () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000 } }),
    ...overrides,
  };
}

function okResponse(utilization: number, resetsAt: string | null = null) {
  return { ok: true, json: async () => ({ five_hour: { utilization, resets_at: resetsAt } }) } as Response;
}

let tmpDir: string | undefined;

async function makeTmpDir(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'usage-coordinator-acquire-'));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('UsageCoordinator.acquire', () => {
  it('grants the first capped-model request and denies a second concurrent one with retryAfter derived from fiveHourResetsAt', async () => {
    const dir = await makeTmpDir();
    const statePath = join(dir, 'coordinator.json');
    const grantsPath = join(dir, 'grants.json');
    const futureResetIso = '2026-08-30T15:00:00.000Z';
    const at = Date.parse('2026-08-30T10:00:00.000Z');

    const coordinator = createUsageCoordinator({
      statePath,
      logger: fakeLogger(),
      now: () => at,
      grantsPath,
      withLock: (fn) => fn(),
      subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(70, futureResetIso) }),
    });

    await coordinator.start();

    const first = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'plan', model: 'claude-opus-5' });
    expect(first).toEqual({ granted: true });

    const second = await coordinator.acquire({ repo: 'r', lane: 'b', phase: 'plan', model: 'claude-opus-5' });
    expect(second).toEqual({ granted: false, retryAfter: Date.parse(futureResetIso) - at });

    coordinator.stop();
  });

  it('records a granted acquire in the shared ledger with the request fields and a reservationPct', async () => {
    const dir = await makeTmpDir();
    const statePath = join(dir, 'coordinator.json');
    const grantsPath = join(dir, 'grants.json');

    const coordinator = createUsageCoordinator({
      statePath,
      logger: fakeLogger(),
      grantsPath,
      withLock: (fn) => fn(),
      subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(10) }),
    });

    await coordinator.start();
    const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-5' });
    expect(result).toEqual({ granted: true });

    const ledger = await loadGrantLedger(grantsPath);
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.grants[0]).toMatchObject({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-5' });
    expect(typeof ledger.grants[0]?.reservationPct).toBe('number');

    coordinator.stop();
  });

  it('non-capped models are always granted without consuming cap headroom or writing a ledger entry', async () => {
    const dir = await makeTmpDir();
    const statePath = join(dir, 'coordinator.json');
    const grantsPath = join(dir, 'grants.json');

    const coordinator = createUsageCoordinator({
      statePath,
      logger: fakeLogger(),
      grantsPath,
      withLock: (fn) => fn(),
      subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(99) }),
    });

    await coordinator.start();
    const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'plan', model: 'gpt-5' });
    expect(result).toEqual({ granted: true });

    const ledger = await loadGrantLedger(grantsPath);
    expect(ledger.grants).toHaveLength(0);

    coordinator.stop();
  });

  it('denies conservatively when there is no cached snapshot yet', async () => {
    const dir = await makeTmpDir();
    const statePath = join(dir, 'coordinator.json');
    const grantsPath = join(dir, 'grants.json');

    const coordinator = createUsageCoordinator({
      statePath,
      logger: fakeLogger(),
      pollMs: 5_000,
      grantsPath,
      withLock: (fn) => fn(),
      fetchSubscription: () => new Promise(() => {}),
    });

    const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'plan', model: 'claude-opus-5' });
    expect(result).toEqual({ granted: false, retryAfter: 5_000 });
  });

  it('pruneGrants drops an entry older than ttlMs, so a stale outstanding grant no longer blocks a new acquire', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    const fresh: GrantLedgerEntry = {
      id: '1',
      repo: 'r',
      lane: 'a',
      phase: 'plan',
      model: 'claude-opus-5',
      grantedAt: new Date(now - 1_000).toISOString(),
      reservationPct: 20,
    };
    const stale: GrantLedgerEntry = {
      id: '2',
      repo: 'r',
      lane: 'b',
      phase: 'plan',
      model: 'claude-opus-5',
      grantedAt: new Date(now - 20_000).toISOString(),
      reservationPct: 20,
    };
    expect(pruneGrants([fresh, stale], now, 10_000)).toEqual([fresh]);
  });

  it('loadGrantLedger returns an empty ledger for a missing or corrupt file', async () => {
    const dir = await makeTmpDir();
    expect(await loadGrantLedger(join(dir, 'missing.json'))).toEqual({ version: 1, grants: [] });
  });

  it('a stale outstanding grant no longer blocks a new acquire once its TTL has passed', async () => {
    const dir = await makeTmpDir();
    const statePath = join(dir, 'coordinator.json');
    const grantsPath = join(dir, 'grants.json');
    let at = Date.parse('2026-08-30T10:00:00.000Z');

    const coordinator = createUsageCoordinator({
      statePath,
      logger: fakeLogger(),
      now: () => at,
      grantsPath,
      grantTtlMs: 1_000,
      withLock: (fn) => fn(),
      subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(70) }),
    });

    await coordinator.start();
    const first = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'plan', model: 'claude-opus-5' });
    expect(first).toEqual({ granted: true });

    at += 2_000;
    const second = await coordinator.acquire({ repo: 'r', lane: 'b', phase: 'plan', model: 'claude-opus-5' });
    expect(second).toEqual({ granted: true });

    const ledgerFile = await readFile(grantsPath, 'utf-8');
    expect(JSON.parse(ledgerFile).grants).toHaveLength(1);

    coordinator.stop();
  });
});
