// src/usage/select-coordinator.ts — Pure selection seam between the daemon-hosted
// UsageCoordinator and the standalone local fallback (#1033).

import type { UsageCoordinator } from './coordinator.js';

export interface SelectUsageCoordinatorOptions {
  daemonPresent: boolean;
  local: () => UsageCoordinator;
  daemon: () => UsageCoordinator;
}

export function selectUsageCoordinator(options: SelectUsageCoordinatorOptions): UsageCoordinator {
  return options.daemonPresent ? options.daemon() : options.local();
}
