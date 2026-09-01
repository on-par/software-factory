import { describe, expect, it } from 'vitest';

import type { UsageCoordinator } from './coordinator.js';
import { selectUsageCoordinator } from './select-coordinator.js';

function fakeCoordinator(name: string): UsageCoordinator {
  return {
    start: async () => {},
    stop: () => {},
    pollNow: async () => null,
    read: () => null,
    acquire: async () => ({ granted: true }),
    // Marker so tests can tell which fake was returned.
    // @ts-expect-error test-only marker not part of the UsageCoordinator interface
    name,
  };
}

describe('selectUsageCoordinator', () => {
  it('returns local() and does not call daemon() when daemonPresent is false', () => {
    let daemonCalled = false;
    const local = fakeCoordinator('local');
    const result = selectUsageCoordinator({
      daemonPresent: false,
      local: () => local,
      daemon: () => {
        daemonCalled = true;
        return fakeCoordinator('daemon');
      },
    });

    expect(result).toBe(local);
    expect(daemonCalled).toBe(false);
  });

  it('returns daemon() and does not call local() when daemonPresent is true', () => {
    let localCalled = false;
    const daemon = fakeCoordinator('daemon');
    const result = selectUsageCoordinator({
      daemonPresent: true,
      local: () => {
        localCalled = true;
        return fakeCoordinator('local');
      },
      daemon: () => daemon,
    });

    expect(result).toBe(daemon);
    expect(localCalled).toBe(false);
  });
});
