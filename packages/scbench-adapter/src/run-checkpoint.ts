// packages/scbench-adapter/src/run-checkpoint.ts — per-checkpoint orchestration (#510).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectArtifacts } from './artifacts.js';
import { materializeBrief } from './brief.js';
import { AdapterError, type CheckpointResult, type ScbenchCheckpoint } from './checkpoint.js';
import { buildRunBriefArgs, runFactory } from './invoke.js';
import { commitCheckpoint, createExecaExec, prepareWorkspace, type ExecFn } from './workspace.js';

export interface RunCheckpointOptions {
  /** Persistent git workspace shared across all checkpoints of a problem. */
  workspace: string;
  /** SCBench's artifact root; brief + Factory artifacts land under
   *  <artifactsRoot>/<problemId>/<checkpointId>/, never inside `workspace`. */
  artifactsRoot: string;
  factoryBin?: string;
}

export interface RunCheckpointDeps {
  exec: ExecFn;
}

/** Drives one checkpoint through Factory: prepare/reuse the workspace, write
 *  the checkpoint's brief outside the workspace, run
 *  `factory run-brief --workspace --artifacts`, validate the resulting
 *  manifest, and commit the workspace so the next checkpoint sees this
 *  checkpoint's edits. Never throws for a failed/parked Factory run — only
 *  adapter-level failures (AdapterError) surface as `outcome: 'error'`. */
export async function runCheckpoint(
  checkpoint: ScbenchCheckpoint,
  opts: RunCheckpointOptions,
  deps: RunCheckpointDeps = { exec: createExecaExec() },
): Promise<CheckpointResult> {
  await prepareWorkspace(opts.workspace, deps);

  const checkpointDir = join(opts.artifactsRoot, checkpoint.problemId, checkpoint.checkpointId);
  mkdirSync(checkpointDir, { recursive: true });

  const briefPath = join(checkpointDir, 'brief.md');
  writeFileSync(briefPath, materializeBrief(checkpoint));

  const args = buildRunBriefArgs({ briefPath, workspace: opts.workspace, artifactsDir: checkpointDir });
  await runFactory(args, { cwd: opts.workspace, factoryBin: opts.factoryBin }, deps);

  let result: CheckpointResult;
  try {
    const { manifestPath, manifest } = collectArtifacts({ artifactsDir: checkpointDir, dest: checkpointDir });
    result = {
      outcome: manifest.run.outcome,
      workspace: opts.workspace,
      artifactsDir: checkpointDir,
      briefPath,
      manifestPath,
    };
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    result = {
      outcome: 'error',
      workspace: opts.workspace,
      artifactsDir: checkpointDir,
      briefPath,
      detail: err.message,
    };
  }

  await commitCheckpoint(opts.workspace, checkpoint.checkpointId, deps);

  return result;
}
