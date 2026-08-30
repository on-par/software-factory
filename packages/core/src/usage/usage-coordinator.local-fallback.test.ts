import { describe, expect, it } from 'vitest';

import type { SubscriptionUsageDeps } from './subscription.js';
import { createLocalUsageCoordinator } from './local-coordinator.js';

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

describe('createLocalUsageCoordinator', () => {
  describe('acquire decision table for a capped model', () => {
    const cases: Array<[number, boolean]> = [
      [0, true],
      [10, true],
      [50, true],
      [79, true],
      [80, true],
      [81, false],
      [99, false],
      [100, false],
    ];

    it.each(cases)('utilization=%i -> granted=%s', async (utilization, granted) => {
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(utilization) }),
      });

      const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-4-8' });
      expect(result.granted).toBe(granted);
    });
  });

  describe('retryAfter', () => {
    it('is resetsMs - now when fiveHourResetsAt is a valid ISO timestamp', async () => {
      const nowMs = 1_000_000;
      const resetsAt = new Date(nowMs + 45_000).toISOString();
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(99, resetsAt) }),
        now: () => nowMs,
      });

      const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-4-8' });
      expect(result).toEqual({ granted: false, retryAfter: 45_000 });
    });

    it('falls back to pollMs when fiveHourResetsAt is null', async () => {
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(99, null) }),
        pollMs: 12_345,
      });

      const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-4-8' });
      expect(result).toEqual({ granted: false, retryAfter: 12_345 });
    });

    it('falls back to pollMs when fiveHourResetsAt is unparsable', async () => {
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(99, 'not-a-date') }),
        pollMs: 6_789,
      });

      const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-4-8' });
      expect(result).toEqual({ granted: false, retryAfter: 6_789 });
    });
  });

  describe('non-Claude passthrough', () => {
    it.each(['gpt-5.6-sol', 'opencode-deepseek-v4-flash'])(
      'grants %s with no fetch and no extra fields',
      async (model) => {
        const coordinator = createLocalUsageCoordinator({
          fetchSubscription: () => {
            throw new Error('should not be called');
          },
        });

        const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model });
        expect(result).toEqual({ granted: true });
        expect(Object.keys(result)).toEqual(['granted']);
      },
    );
  });

  it('grants a capped model when the signal is unavailable, unlike the daemon coordinator', async () => {
    const coordinator = createLocalUsageCoordinator({
      fetchSubscription: async () => null,
    });

    const result = await coordinator.acquire({ repo: 'r', lane: 'a', phase: 'build', model: 'claude-opus-4-8' });
    expect(result).toEqual({ granted: true });
  });

  describe('read/start/pollNow', () => {
    it('read() is null before any fetch, and reflects the snapshot after start()', async () => {
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(42) }),
      });

      expect(coordinator.read()).toBeNull();
      await coordinator.start();
      expect(coordinator.read()).toEqual({ fiveHourUtilization: 42, fiveHourResetsAt: null });
    });

    it('read() reflects the snapshot after pollNow(), and returns a distinct object copy', async () => {
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(7) }),
      });

      await coordinator.pollNow();
      const first = coordinator.read();
      expect(first).toEqual({ fiveHourUtilization: 7, fiveHourResetsAt: null });

      // Mutating the returned copy must not affect the next read().
      (first as { fiveHourUtilization: number }).fiveHourUtilization = 999;
      const second = coordinator.read();
      expect(second).toEqual({ fiveHourUtilization: 7, fiveHourResetsAt: null });
      expect(second).not.toBe(first);
    });

    it('stop() is a no-op', async () => {
      const coordinator = createLocalUsageCoordinator({
        subscriptionDeps: credentialsDeps({ fetchImpl: async () => okResponse(1) }),
      });
      expect(() => coordinator.stop()).not.toThrow();
    });
  });
});
