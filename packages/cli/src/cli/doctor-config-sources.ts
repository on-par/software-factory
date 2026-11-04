// src/cli/doctor-config-sources.ts — the `config sources` doctor row and `--json` sources field (#3906).

import { describeConfigSources, holdRunConfigSnapshot, lastRunConfigLadder } from '@on-par/factory-core/internal';
import type { RunConfigLadder } from '@on-par/factory-core/internal';

import { constitutionSourceLabel } from './config-override-option.js';
import { REPO_SECTION, type DoctorCheck } from './doctor.js';

export interface DoctorConfigSources {
  config: { source: string; path?: string; overrideKeys: string[] };
  constitution: { source: string };
}

/** The `config sources` row: which config and constitution the run would start from; keys only, never values. */
export function configSourcesCheck(ladder: RunConfigLadder, constitution: string): DoctorCheck {
  return {
    name: 'config sources',
    section: REPO_SECTION,
    ok: true,
    detail: describeConfigSources(ladder, constitution),
  };
}

export interface HeldDoctorConfig {
  release: () => void;
  check: DoctorCheck;
  sources: DoctorConfigSources | null;
}

/** Snapshot the ladder so the config loaders doctor calls see the overrides. A ladder error becomes a
 *  failing row and never aborts doctor. */
export function holdDoctorConfigSources(repoRoot: string, configPath: string): HeldDoctorConfig {
  try {
    const release = holdRunConfigSnapshot(configPath);
    const ladder = lastRunConfigLadder();
    const constitution = constitutionSourceLabel(repoRoot);
    if (!ladder)
      return { release, check: { name: 'config sources', ok: true, detail: 'packaged defaults' }, sources: null };
    const config: DoctorConfigSources['config'] = { source: ladder.source, overrideKeys: ladder.overrideKeys };
    if (ladder.path !== undefined) config.path = ladder.path;
    return {
      release,
      check: configSourcesCheck(ladder, constitution),
      sources: { config, constitution: { source: constitution } },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const check: DoctorCheck = {
      name: 'config sources',
      section: REPO_SECTION,
      ok: false,
      detail,
      fix: 'fix the --config / FACTORY_CONFIG_* / FACTORY_CONSTITUTION* override named above',
    };
    return { release: () => {}, check, sources: null };
  }
}
