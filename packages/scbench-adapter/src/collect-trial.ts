// packages/scbench-adapter/src/collect-trial.ts — copy a trial's Factory artifacts into the baseline runs tree (#1148).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectArtifacts, type ArtifactsFsDeps } from './artifacts.js';
import { AdapterError } from './checkpoint.js';

/** The five Factory artifacts a baseline trial directory must retain
 *  (evals/scbench-baseline/README.md). Native SCBench evidence
 *  (NATIVE_EVIDENCE_FILES) is out of scope here (#1148). */
export const FACTORY_TRIAL_FILES = [
  'manifest.json',
  'request.json',
  'events.ndjson',
  'diff.patch',
  'brief.md',
] as const;

export interface CollectTrialOptions {
  /** Completed SCBench output tree root — the adapter's artifactsRoot; the
   *  checkpoint directory is <outputTree>/<problemId>/<checkpointId>/. */
  outputTree: string;
  problemId: string;
  checkpointId: string;
  /** 1-based trial number; the trial directory is named trial-<trial>. */
  trial: number;
  /** Baseline runs root, e.g. evals/scbench-baseline/runs. */
  runsDir: string;
}

export interface CollectTrialResult {
  sourceDir: string;
  trialDir: string;
  copied: string[];
}

const REAL_FS: ArtifactsFsDeps = { existsSync, readFileSync, mkdirSync, copyFileSync };

/** Copies the five Factory artifacts for one trial from
 *  <outputTree>/<problemId>/<checkpointId>/ into
 *  <runsDir>/<problemId>/<checkpointId>/trial-<trial>/, creating the trial
 *  directory when absent. Throws AdapterError naming every missing file
 *  before any write, and reuses collectArtifacts' same-dir validation-only
 *  mode for manifest existence/parse/version checks. */
export function collectTrial(opts: CollectTrialOptions, deps: ArtifactsFsDeps = REAL_FS): CollectTrialResult {
  const sourceDir = join(opts.outputTree, opts.problemId, opts.checkpointId);

  const missing = FACTORY_TRIAL_FILES.filter((f) => !deps.existsSync(join(sourceDir, f)));
  if (missing.length > 0) {
    throw new AdapterError(`missing Factory artifact(s) in ${sourceDir}: ${missing.join(', ')}`);
  }

  collectArtifacts({ artifactsDir: sourceDir, dest: sourceDir }, deps);

  const trialDir = join(opts.runsDir, opts.problemId, opts.checkpointId, `trial-${opts.trial}`);
  deps.mkdirSync(trialDir, { recursive: true });

  const copied: string[] = [];
  for (const name of FACTORY_TRIAL_FILES) {
    deps.copyFileSync(join(sourceDir, name), join(trialDir, name));
    copied.push(name);
  }

  return { sourceDir, trialDir, copied };
}
