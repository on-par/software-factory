// packages/scbench-adapter/src/collect-trial.ts — copy a trial's Factory artifacts + native SCBench evidence into the baseline runs tree (#1148, #1149).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectArtifacts, NATIVE_EVIDENCE_FILES, type ArtifactsFsDeps } from './artifacts.js';
import { AdapterError } from './checkpoint.js';

/** The five Factory artifacts a baseline trial directory must retain
 *  (evals/scbench-baseline/README.md). Native SCBench evidence
 *  (NATIVE_EVIDENCE_FILES) is collected separately below (#1149). */
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
  /** Completed SCBench run output directory (the launcher's save_dir run root).
   *  At the pinned commit: checkpoint_results.jsonl lives at <scbenchRunDir>/,
   *  run_info.yaml at <scbenchRunDir>/<problemId>/, and evaluation.json at
   *  <scbenchRunDir>/<problemId>/<checkpointId>/. */
  scbenchRunDir: string;
}

export interface CollectTrialResult {
  sourceDir: string;
  trialDir: string;
  copied: string[];
  /** True when the trial directory already held all expected files and nothing was written. */
  alreadyImported: boolean;
}

const REAL_FS: ArtifactsFsDeps = { existsSync, readFileSync, mkdirSync, copyFileSync };

/** Derives the three native-evidence source paths at the pinned SCBench
 *  commit's run-output layout: checkpoint_results.jsonl at <scbenchRunDir>/,
 *  run_info.yaml at <scbenchRunDir>/<problemId>/, evaluation.json at
 *  <scbenchRunDir>/<problemId>/<checkpointId>/. */
function nativeEvidenceSourcePaths(
  scbenchRunDir: string,
  problemId: string,
  checkpointId: string,
): Record<(typeof NATIVE_EVIDENCE_FILES)[number], string> {
  return {
    'evaluation.json': join(scbenchRunDir, problemId, checkpointId, 'evaluation.json'),
    'checkpoint_results.jsonl': join(scbenchRunDir, 'checkpoint_results.jsonl'),
    'run_info.yaml': join(scbenchRunDir, problemId, 'run_info.yaml'),
  };
}

/** Copies the five Factory artifacts plus the three native SCBench evidence
 *  files for one trial from <outputTree>/<problemId>/<checkpointId>/ and
 *  <scbenchRunDir>/ into <runsDir>/<problemId>/<checkpointId>/trial-<trial>/,
 *  creating the trial directory when absent. Throws AdapterError naming
 *  every missing file before any write — reusing collectArtifacts' same-dir
 *  validation-only mode for manifest existence/parse/version checks, and
 *  failing closed (nothing written) when any native evidence file is absent,
 *  so a trial can never be read as passing without it (ADR-0007). Idempotent:
 *  when the trial directory already holds all 8 expected files, performs zero
 *  writes and returns alreadyImported: true — the prior import wins, and
 *  source-vs-imported divergence is deliberately not reconciled (#1150). A
 *  partial import (some but not all files present) is completed by the
 *  existing copy loop below. */
export function collectTrial(opts: CollectTrialOptions, deps: ArtifactsFsDeps = REAL_FS): CollectTrialResult {
  const sourceDir = join(opts.outputTree, opts.problemId, opts.checkpointId);

  const missing = FACTORY_TRIAL_FILES.filter((f) => !deps.existsSync(join(sourceDir, f)));
  if (missing.length > 0) {
    throw new AdapterError(`missing Factory artifact(s) in ${sourceDir}: ${missing.join(', ')}`);
  }

  collectArtifacts({ artifactsDir: sourceDir, dest: sourceDir }, deps);

  const evidencePaths = nativeEvidenceSourcePaths(opts.scbenchRunDir, opts.problemId, opts.checkpointId);
  const missingEvidence = NATIVE_EVIDENCE_FILES.filter((f) => !deps.existsSync(evidencePaths[f]));
  if (missingEvidence.length > 0) {
    throw new AdapterError(
      `native SCBench evidence missing for trial ${opts.problemId}/${opts.checkpointId}/trial-${opts.trial}: ` +
        missingEvidence.map((f) => `${f} (expected at ${evidencePaths[f]})`).join(', ') +
        ' — trial is missing-evidence; nothing was written (ADR-0007: no passing trial without native evidence)',
    );
  }

  const trialDir = join(opts.runsDir, opts.problemId, opts.checkpointId, `trial-${opts.trial}`);

  const expectedFiles = [...FACTORY_TRIAL_FILES, ...NATIVE_EVIDENCE_FILES];
  const alreadyImported = expectedFiles.every((name) => deps.existsSync(join(trialDir, name)));
  if (alreadyImported) {
    return { sourceDir, trialDir, copied: [], alreadyImported: true };
  }

  deps.mkdirSync(trialDir, { recursive: true });

  const copied: string[] = [];
  for (const name of FACTORY_TRIAL_FILES) {
    deps.copyFileSync(join(sourceDir, name), join(trialDir, name));
    copied.push(name);
  }
  for (const name of NATIVE_EVIDENCE_FILES) {
    deps.copyFileSync(evidencePaths[name], join(trialDir, name));
    copied.push(name);
  }

  return { sourceDir, trialDir, copied, alreadyImported: false };
}
