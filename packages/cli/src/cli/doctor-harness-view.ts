import { applyRepoConfig } from '@on-par/factory-core';

import type { DoctorRuntime } from './doctor.js';

/** The harness view doctor judges with: packaged harnesses merged with `.factory/config.yaml` (#2870). */
export interface DoctorHarnessView {
  /** `applyRepoConfig(...).harnesses`; undefined when loading or merging threw. */
  merged?: Readonly<Record<string, { command: string; agentic: boolean }>>;
  registry?: Readonly<Record<string, { harness?: string }>>;
  /** Packaged plus repo-declared harness ids, even when the merge threw. */
  declaredIds: string[];
  /** The applyRepoConfig error; undefined when it succeeded or when loading the repo config threw (the config row reports that). */
  mergeError?: string;
}

export function resolveDoctorHarnesses(
  loaders: Pick<DoctorRuntime['configLoaders'], 'loadModelsConfig' | 'loadRepoConfig'>,
  repoRoot: string,
): DoctorHarnessView {
  let models: ReturnType<typeof loaders.loadModelsConfig>;
  let repo: ReturnType<typeof loaders.loadRepoConfig>;
  try {
    models = loaders.loadModelsConfig();
    repo = loaders.loadRepoConfig(repoRoot);
  } catch {
    return { declaredIds: [] };
  }
  const registry = repo?.models?.registry;
  const declaredIds = [...new Set([...Object.keys(models.harnesses ?? {}), ...Object.keys(repo?.harnesses ?? {})])];
  try {
    return { merged: applyRepoConfig(models, repo).harnesses, registry, declaredIds };
  } catch (err) {
    return { registry, declaredIds, mergeError: err instanceof Error ? err.message : String(err) };
  }
}
