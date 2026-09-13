// packages/cli/src/cli/run-flags.ts — per-invocation `--auto-merge` and `--admin-merge`
// overrides, recorded so a separate `factory status` process can attribute a run's policy (#1400, #1402).

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Flags an operator supplied explicitly on this invocation. `undefined` = not supplied. */
export interface RunFlagOverrides {
  autoMerge?: boolean;
  adminMerge?: boolean;
}

/** Read the recorded overrides. Fails soft: a missing, unreadable, non-JSON, non-object,
 *  or wrongly-typed file reads as "no override" rather than throwing, so a corrupt state
 *  file can never break `factory status` or a run. */
export function readRunFlagOverrides(file: string): RunFlagOverrides {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const autoMerge = (raw as { autoMerge?: unknown }).autoMerge;
  const adminMerge = (raw as { adminMerge?: unknown }).adminMerge;
  const overrides: RunFlagOverrides = {};
  if (typeof autoMerge === 'boolean') overrides.autoMerge = autoMerge;
  if (typeof adminMerge === 'boolean') overrides.adminMerge = adminMerge;
  return overrides;
}

/** Record the overrides for this invocation. Writing an all-`undefined` set removes the
 *  file, so a flag from an earlier run can never leak into a later flagless one. */
export function writeRunFlagOverrides(file: string, overrides: RunFlagOverrides): void {
  const recorded: RunFlagOverrides = {};
  if (overrides.autoMerge !== undefined) recorded.autoMerge = overrides.autoMerge;
  if (overrides.adminMerge !== undefined) recorded.adminMerge = overrides.adminMerge;
  if (Object.keys(recorded).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(recorded, null, 2)}\n`);
}
