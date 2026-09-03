import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import type { SubscriptionUsageDeps } from './subscription.js';
import { createUsageCoordinator } from './coordinator.js';
import { loadGrantLedger } from './grant-ledger.js';

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
  tmpDir = await mkdtemp(join(tmpdir(), 'usage-coordinator-non-claude-'));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('UsageCoordinator.acquire non-Claude passthrough', () => {
  it('grants a codex route with high Claude utilization, no retryAfter/utilization field, and no ledger entry', async () => {
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
    const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'gpt-5.6-sol' });
    expect(result).toEqual({ granted: true });
    expect(Object.keys(result)).toEqual(['granted']);

    const ledger = await loadGrantLedger(grantsPath);
    expect(ledger.grants).toHaveLength(0);

    coordinator.stop();
  });

  it('grants an opencode route with high Claude utilization, no retryAfter/utilization field, and no ledger entry', async () => {
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
    const result = await coordinator.acquire({
      repo: 'r',
      lane: 'a',
      phase: 'build',
      model: 'opencode-deepseek-v4-flash',
    });
    expect(result).toEqual({ granted: true });
    expect(Object.keys(result)).toEqual(['granted']);

    const ledger = await loadGrantLedger(grantsPath);
    expect(ledger.grants).toHaveLength(0);

    coordinator.stop();
  });

  it('grants a non-Claude route even when there is no cached snapshot yet, unlike the Claude route which denies conservatively', async () => {
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

    const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'plan', model: 'gpt-5.6-sol' });
    expect(result).toEqual({ granted: true });
    expect(Object.keys(result)).toEqual(['granted']);

    const ledger = await loadGrantLedger(grantsPath);
    expect(ledger.grants).toHaveLength(0);
  });

  it('grants a non-Claude route with low Claude utilization too, confirming the passthrough is independent of snapshot value', async () => {
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
    const result = await coordinator.acquire({
      repo: 'r',
      lane: 'a',
      phase: 'plan',
      model: 'opencode/deepseek-v4-flash-free',
    });
    expect(result).toEqual({ granted: true });
    expect(Object.keys(result)).toEqual(['granted']);

    const ledger = await loadGrantLedger(grantsPath);
    expect(ledger.grants).toHaveLength(0);

    coordinator.stop();
  });
});
