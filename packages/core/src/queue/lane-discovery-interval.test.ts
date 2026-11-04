// packages/core/src/queue/lane-discovery-interval.test.ts — queue.discovery_interval_ms resolution (#3920).

import { describe, expect, it } from 'vitest';

import { loadFactoryConfig } from '../config/index.js';
import { DEFAULT_LANE_DISCOVERY_INTERVAL_MS, resolveLaneDiscoveryIntervalMs } from './lane-discovery-interval.js';

describe('resolveLaneDiscoveryIntervalMs (#3920)', () => {
  it('defaults to 60000 ms', () => {
    expect(resolveLaneDiscoveryIntervalMs(loadFactoryConfig())).toBe(60000);
    expect(DEFAULT_LANE_DISCOVERY_INTERVAL_MS).toBe(60000);
  });

  it('reads queue.discovery_interval_ms from config', () => {
    const base = loadFactoryConfig();
    expect(resolveLaneDiscoveryIntervalMs({ queue: { ...base.queue, discovery_interval_ms: 5000 } })).toBe(5000);
  });
});
