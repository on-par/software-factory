// packages/core/src/queue/lane-discovery-interval.ts — how often a running `factory run` discovers new lanes (#3920).

import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';

/** Default wait between lane-discovery passes in a running factory run (#3920). */
export const DEFAULT_LANE_DISCOVERY_INTERVAL_MS = 60_000;

/** Milliseconds between lane-discovery passes, from validated config (#3920). */
export function resolveLaneDiscoveryIntervalMs(config: Pick<FactoryConfig, 'queue'>): number {
  return config.queue?.discovery_interval_ms ?? defaultFactoryConfig.queue.discovery_interval_ms;
}
