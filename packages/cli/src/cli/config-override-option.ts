// src/cli/config-override-option.ts — global --config / --constitution flags and the run's config-source report (#3906).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  describeConfigSources,
  lastRunConfigLadder,
  logEvent,
  resolveConstitutionOverride,
} from '@on-par/factory-core/internal';

/** Resolve each set flag to an absolute path and hand it to every command, lane and CHECK
 *  subprocess through env. A missing file throws. */
export function applyConfigOverrideOptions(
  flags: { config?: string; constitution?: string },
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
}

/** Label of the constitution source a run uses: an override, the committed instance, or repo files / bundled. */
export function constitutionSourceLabel(repoRoot: string): string {
  return (
    resolveConstitutionOverride()?.source ??
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
  const text = describeConfigSources(ladder, constitution);
  console.log(`factory: ${text}`);
  logEvent(eventsFile, 'config_source', issueNum, text, { level: 'info' });
}
