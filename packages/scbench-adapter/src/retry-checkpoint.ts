// packages/scbench-adapter/src/retry-checkpoint.ts — bounded rework re-invocation of run-brief (#1163).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectArtifacts } from './artifacts.js';
import { materializeRetryBrief } from './brief.js';
import { AdapterError, type CheckpointResult, type ScbenchCheckpoint } from './checkpoint.js';
import { buildRunBriefArgs, runFactory } from './invoke.js';
import type { ScbenchRetryContext } from './retry-context.js';
import type { RunCheckpointDeps, RunCheckpointOptions } from './run-checkpoint.js';
import { commitCheckpoint, createExecaExec, prepareWorkspace } from './workspace.js';

export interface RetryCheckpointResult extends CheckpointResult {
  /** Path of the persisted retry-context.json inside the rework directory. */
  retryContextPath: string;
}

/** Drives one bounded rework attempt for an already-evaluated failed
 *  checkpoint: writes the retry context + enriched brief into a `rework-1/`
 *  subdirectory of the checkpoint's artifacts dir (never into the checkpoint
 *  directory itself, so first-attempt evidence stays byte-identical — see
 *  ADR-0071), re-invokes `factory run-brief` exactly as runCheckpoint does,
 *  and commits the workspace as `<checkpointId>-rework-1`. Exactly one retry
 *  is recordable: an existing rework-1 manifest fails closed before any side
 *  effect. Never throws for a failed/parked Factory run — only adapter-level
 *  failures (AdapterError) surface as `outcome: 'error'`. */
export async function retryCheckpoint(
  checkpoint: ScbenchCheckpoint,
  ctx: ScbenchRetryContext,
  opts: RunCheckpointOptions,
  deps: RunCheckpointDeps = { exec: createExecaExec() },
): Promise<RetryCheckpointResult> {
  const reworkDir = join(opts.artifactsRoot, checkpoint.problemId, checkpoint.checkpointId, 'rework-1');
  if (existsSync(join(reworkDir, 'manifest.json'))) {
    throw new AdapterError(`retry already recorded at ${reworkDir} — one rework attempt per checkpoint`);
  }

  await prepareWorkspace(opts.workspace, deps);
  mkdirSync(reworkDir, { recursive: true });

  const retryContextPath = join(reworkDir, 'retry-context.json');
  writeFileSync(retryContextPath, JSON.stringify(ctx, null, 2));
  const briefPath = join(reworkDir, 'brief.md');
  writeFileSync(briefPath, materializeRetryBrief(checkpoint, ctx));

  const args = buildRunBriefArgs({ briefPath, workspace: opts.workspace, artifactsDir: reworkDir });
  const factoryResult = await runFactory(args, { cwd: opts.workspace, factoryBin: opts.factoryBin }, deps);

  let result: RetryCheckpointResult;
  try {
    const { manifestPath, manifest } = collectArtifacts({ artifactsDir: reworkDir, dest: reworkDir });
    result = {
      outcome: manifest.run.outcome,
      workspace: opts.workspace,
      artifactsDir: reworkDir,
      briefPath,
      manifestPath,
      retryContextPath,
    };
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    const factoryDetail =
      factoryResult.exitCode !== 0
        ? ` (factory exited ${factoryResult.exitCode}: ${factoryResult.stderr || factoryResult.stdout || 'no output'})`
        : '';
    result = {
      outcome: 'error',
      workspace: opts.workspace,
      artifactsDir: reworkDir,
      briefPath,
      retryContextPath,
      detail: `${err.message}${factoryDetail}`,
    };
  }

  // A commit failure is a bookkeeping problem, not a Factory-run outcome —
  // it must never discard an already-resolved result (ready/failed/parked/
  // escalated/error). Fold it into `detail` instead of throwing.
  try {
    await commitCheckpoint(opts.workspace, `${checkpoint.checkpointId}-rework-1`, deps);
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    const commitDetail = `workspace commit failed: ${err.message}`;
    result = { ...result, detail: result.detail ? `${result.detail}; ${commitDetail}` : commitDetail };
  }

  return result;
}
