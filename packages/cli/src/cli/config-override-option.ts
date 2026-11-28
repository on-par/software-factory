// src/cli/config-override-option.ts — global --config / --constitution flags and the run's config-source report (#3906).

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  describeConfigSources,
  holdRunConfigSnapshot,
  lastRunConfigLadder,
  logEvent,
  projectConfigReport,
  resolveConstitutionOverride,
  resolveProjectConfigDir,
  validateProjectInputs,
} from '@on-par/factory-core/internal';

export { excludeProjectRunState } from '@on-par/factory-core/internal';

/** Resolve each set flag to an absolute path and hand it to every command, lane and CHECK
 *  subprocess through env. A missing file throws. */
export function applyConfigOverrideOptions(
  flags: { config?: string; constitution?: string; projectConfig?: string },
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const apply = (flag: string, value: string | undefined, pathVar: string): void => {
    if (value === undefined) return;
    const abs = resolve(cwd, value);
    if (!existsSync(abs)) throw new Error(`${flag}: no such file: ${abs}`);
    env[pathVar] = abs;
    env[`${pathVar}_SOURCE`] = flag;
  };
  apply('--config', flags.config, 'FACTORY_CONFIG_PATH');
  apply('--constitution', flags.constitution, 'FACTORY_CONSTITUTION_PATH');
  if (flags.projectConfig !== undefined) {
    const abs = resolve(cwd, flags.projectConfig);
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new Error(`--project-config: no such directory: ${abs}`);
    env.FACTORY_PROJECT_CONFIG_DIR = abs;
    env.FACTORY_PROJECT_CONFIG_DIR_SOURCE = '--project-config';
  }
}

/** Label of the constitution source a run uses: an override, the committed instance, or repo files / bundled. */
export function constitutionSourceLabel(repoRoot: string): string {
  return (
    resolveConstitutionOverride()?.source ??
    resolveProjectConfigDir()?.source ??
    (existsSync(join(repoRoot, '.factory', 'constitution.md'))
      ? '.factory/constitution.md'
      : 'repo instruction files / bundled')
  );
}

/** Print and record the sources the run's config and constitution came from; keys only, never values. */
export function reportConfigSource(repoRoot: string, eventsFile: string, issueNum: number): void {
  const ladder = lastRunConfigLadder();
  if (!ladder) return;
  const constitution = constitutionSourceLabel(repoRoot);
  const projectConfig = projectConfigReport(repoRoot);
  const text = describeConfigSources(ladder, constitution, projectConfig);
  console.log(`factory: ${text}`);
  logEvent(eventsFile, 'config_source', issueNum, text, { level: 'info', projectConfig });
}

export function holdRunInputs(configPath: string, env: NodeJS.ProcessEnv = process.env): () => void {
  const release = holdRunConfigSnapshot(configPath, env);
  try {
    validateProjectInputs(env);
    return release;
  } catch (err) {
    release();
    throw err;
  }
}
