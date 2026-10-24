// src/config/repo-config-label.ts — Display label of the file a repo config was loaded from (#3604)

import type { RepoFactoryConfig } from './repo.js';

const labels = new WeakMap<object, string>();

export const DEFAULT_REPO_CONFIG_LABEL = '.factory/config.json';

/** Tag a loaded repo config with the display label of the file it came from (#3604). Returns `config`. */
export function recordRepoConfigLabel<T extends object>(config: T, label: string): T {
  labels.set(config, label);
  return config;
}

/** Display label of the file `config` was loaded from; DEFAULT_REPO_CONFIG_LABEL for in-memory configs. */
export function repoConfigLabel(config: RepoFactoryConfig | null | undefined): string {
  return (config && labels.get(config)) ?? DEFAULT_REPO_CONFIG_LABEL;
}
