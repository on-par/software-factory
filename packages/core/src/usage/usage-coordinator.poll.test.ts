import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FactoryLogger } from '../logger/index.js';
import type { SubscriptionUsageDeps } from './subscription.js';
import {
  createUsageCoordinator,
  DEFAULT_USAGE_POLL_MS,
  loadUsageState,
  writeUsageState,
  type UsageCoordinatorState,
} from './coordinator.js';

function fakeLogger(): { logger: FactoryLogger; warnings: Array<{ type: string; message: string }> } {
  const warnings: Array<{ type: string; message: string }> = [];
  const logger: FactoryLogger = {
    debug: () => {},
    info: () => {},
    warn: (type, message) => warnings.push({ type, message }),
    error: () => {},
    child: () => logger,
  };
  return { logger, warnings };
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

async function makeStatePath(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'usage-coordinator-'));
  return join(tmpDir, 'coordinator.json');
}

afterEach(async () => {
  vi.useRealTimers();
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('createUsageCoordinator', () => {
  it('polls once on start and once per interval (deterministic clock, no real network)', async () => {
    vi.useFakeTimers();
    const statePath = await makeStatePath();
    const { logger } = fakeLogger();
    const fetchImpl = vi.fn(async () => okResponse(0.1));
    const coordinator = createUsageCoordinator({
      statePath,
      logger,
      subscriptionDeps: credentialsDeps({ fetchImpl }),
    });

    await coordinator.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(coordinator.read()).toEqual({ fiveHourUtilization: 0.1, fiveHourResetsAt: null });

    await vi.advanceTimersByTimeAsync(DEFAULT_USAGE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    coordinator.stop();
  });

  it('is the single poller: two independent reads across a compressed 5-hour window agree with each other and the last poll', async () => {
    vi.useFakeTimers();
    const statePath = await makeStatePath();
    const { logger } = fakeLogger();
    const pollMs = 60_000;
    let utilization = 0;
    const fetchImpl = vi.fn(async () => {
      utilization += 0.05;
      return okResponse(utilization);
    });
    const coordinator = createUsageCoordinator({
      statePath,
      logger,
      pollMs,
      subscriptionDeps: credentialsDeps({ fetchImpl }),
      // Avoid real disk I/O in a 300-iteration compressed-clock loop; the
      // atomic-write path itself is covered separately by the persistence tests.
      writeState: async () => {},
    });

    await coordinator.start();
    const intervalsInFiveHours = (5 * 60 * 60_000) / pollMs;
    await vi.advanceTimersByTimeAsync(intervalsInFiveHours * pollMs);

    expect(fetchImpl).toHaveBeenCalledTimes(intervalsInFiveHours + 1);
    const callsBeforeReads = fetchImpl.mock.calls.length;

    const engineOneView = coordinator.read();
    const engineTwoView = coordinator.read();
    expect(engineOneView).toEqual(engineTwoView);
    expect(engineOneView).toEqual({ fiveHourUtilization: utilization, fiveHourResetsAt: null });
    expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeReads);

    coordinator.stop();
  });

  it('hydrates read() from persisted state on start before the first poll resolves', async () => {
    const statePath = await makeStatePath();
    const persisted: UsageCoordinatorState = {
      version: 1,
      snapshot: { fiveHourUtilization: 0.42, fiveHourResetsAt: '2026-08-30T12:00:00.000Z' },
      fetchedAt: '2026-08-30T10:00:00.000Z',
    };
    await writeUsageState(statePath, persisted);

    const { logger } = fakeLogger();
    let resolvePoll: (value: null) => void = () => {};
    const pending = new Promise<null>((resolve) => {
      resolvePoll = resolve;
    });
    const coordinator = createUsageCoordinator({
      statePath,
      logger,
      fetchSubscription: () => pending,
    });

    const starting = coordinator.start();
    // loadUsageState performs real fs I/O before the (still-pending) first poll,
    // so give the event loop a few real ticks to let hydration land.
    for (let i = 0; i < 50 && coordinator.read() === null; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(coordinator.read()).toEqual(persisted.snapshot);

    resolvePoll(null);
    await starting;
    coordinator.stop();
  });

  it('keeps the last good snapshot and persisted file when a poll returns null', async () => {
    vi.useFakeTimers();
    const statePath = await makeStatePath();
    const { logger, warnings } = fakeLogger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(0.2))
      .mockResolvedValue({ ok: false } as Response);
    const coordinator = createUsageCoordinator({
      statePath,
      logger,
      subscriptionDeps: credentialsDeps({ fetchImpl }),
    });

    await coordinator.start();
    expect(coordinator.read()).toEqual({ fiveHourUtilization: 0.2, fiveHourResetsAt: null });
    const fileAfterFirstPoll = await readFile(statePath, 'utf-8');

    await vi.advanceTimersByTimeAsync(DEFAULT_USAGE_POLL_MS);
    expect(coordinator.read()).toEqual({ fiveHourUtilization: 0.2, fiveHourResetsAt: null });
    expect(await readFile(statePath, 'utf-8')).toEqual(fileAfterFirstPoll);
    expect(warnings.some((w) => w.type === 'usage_coordinator_poll_empty')).toBe(true);

    coordinator.stop();
  });

  it('loadUsageState is tolerant of a missing or corrupt file and writeUsageState round-trips a snapshot', async () => {
    const statePath = await makeStatePath();

    expect(await loadUsageState(join(tmpdir(), `missing-${randomUUID()}.json`))).toEqual({
      version: 1,
      snapshot: null,
      fetchedAt: null,
    });

    await writeFile(statePath, 'not json');
    expect(await loadUsageState(statePath)).toEqual({ version: 1, snapshot: null, fetchedAt: null });

    const state: UsageCoordinatorState = {
      version: 1,
      snapshot: { fiveHourUtilization: 0.33, fiveHourResetsAt: null },
      fetchedAt: '2026-08-30T00:00:00.000Z',
    };
    await writeUsageState(statePath, state);
    expect(await loadUsageState(statePath)).toEqual(state);

    const order: string[] = [];
    await writeUsageState(statePath, state, {
      writeFile: async (f) => {
        order.push(`write:${f}`);
      },
      rename: async (from, to) => {
        order.push(`rename:${from}->${to}`);
      },
    });
    expect(order).toEqual([`write:${statePath}.tmp`, `rename:${statePath}.tmp->${statePath}`]);
  });

  it('stop() halts future polls, pollNow() dedupes concurrent calls, and a non-positive pollMs throws', async () => {
    vi.useFakeTimers();
    const statePath = await makeStatePath();
    const { logger } = fakeLogger();
    const fetchImpl = vi.fn(async () => okResponse(0.5));
    const coordinator = createUsageCoordinator({
      statePath,
      logger,
      subscriptionDeps: credentialsDeps({ fetchImpl }),
    });

    await coordinator.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    coordinator.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_USAGE_POLL_MS * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [first, second] = [coordinator.pollNow(), coordinator.pollNow()];
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(() => createUsageCoordinator({ statePath, logger, pollMs: 0 })).toThrow(RangeError);
    expect(() => createUsageCoordinator({ statePath, logger, pollMs: -1 })).toThrow(RangeError);
  });
});
