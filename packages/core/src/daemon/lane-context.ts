// src/daemon/lane-context.ts — Separates a daemon-selected checkout root from
// its registered factory-state root (#843).

import { getFactoryPaths } from '../config/index.js';
import type { RepoRegistryListing } from './registry.js';

export interface DaemonLaneContext {
  /** Selected checkout root for repository and Git operations. */
  repoRoot: string;
  /** Resolved factory state paths for the selected registry entry. */
  paths: ReturnType<typeof getFactoryPaths>;
}

/** Creates the path context for one selected daemon registry entry. */
export function createDaemonLaneContext(entry: RepoRegistryListing): DaemonLaneContext {
  return {
    repoRoot: entry.path,
    paths: getFactoryPaths(entry.path, entry.stateRoot),
  };
}
