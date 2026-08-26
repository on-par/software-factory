// src/hosted/container.ts — Executes a leased hosted-exec job inside a
// disposable container (#899, parent #895/#897/#898). All Docker and
// workspace-fs effects sit behind the injected ContainerEngine port so the
// orchestrator is hermetic and testable with a fake engine; the real
// docker-CLI adapter lives in docker.ts.
import type { HostedJobResult } from '@on-par/contracts';

import type { HostedJobStore, JobUpdateResult } from './store.js';

export interface CloneOutcome {
  /** True when the fresh clone succeeded. */
  ok: boolean;
  /** Resolved HEAD commit SHA when ok — recorded workspace identity. */
  commit?: string;
  /** Failure reason (git stderr / message) when !ok. */
  error?: string;
}

export interface PreparedWorkspace {
  /** Absolute host path mounted into the container. */
  hostPath: string;
  /** Path the payload is readable at inside the container, e.g. /workspace/payload. */
  containerPayloadPath: string;
  /** Path inside the container where the fresh repo clone lives, e.g. /workspace/repo. */
  containerRepoPath: string;
  /** Result of cloning repoSlug into the workspace. */
  clone: CloneOutcome;
}

export interface ContainerRunSpec {
  jobId: string;
  image: string;
  command: string[];
  workspaceHostPath: string;
  /** Mount target inside the container, e.g. /workspace. */
  mountPath: string;
  timeoutMs: number;
}

export interface ContainerRunResult {
  containerName: string;
  exitCode: number;
  logs: string;
  timedOut: boolean;
}

export interface ContainerCleanupProof {
  containerName: string;
  removed: boolean;
  workspaceRemoved: boolean;
  /** Human/audit evidence string, e.g. 'removed sf-job-job-1; no container matches name'. */
  evidence: string;
}

export interface ContainerEngine {
  prepareWorkspace(jobId: string, payload: string, repoSlug: string): Promise<PreparedWorkspace>;
  run(spec: ContainerRunSpec): Promise<ContainerRunResult>;
  remove(jobId: string, workspaceHostPath: string): Promise<ContainerCleanupProof>;
}

export interface ContainerJobConfig {
  jobId: string;
  leaseId: string;
  image: string;
  command: string[];
  /** default '/workspace' */
  mountPath?: string;
  timeoutMs: number;
}

export interface ContainerJobOutcome {
  jobId: string;
  ranContainer: boolean;
  containerName?: string;
  exitCode?: number;
  outcome?: 'completed' | 'failed';
  result?: HostedJobResult;
  cleanup?: ContainerCleanupProof;
  workspaceCommit?: string;
  trace: string;
}

/** Runs a leased job inside a disposable container: prepares a host
 * workspace with the job payload, runs the container, drives the job to
 * completed/failed from the exit code, then always removes the container +
 * workspace and records cleanup proof back into the store. No clock, no
 * direct I/O — determinism comes from the store's injected clock and the
 * injected engine. */
export async function runContainerJob(
  store: HostedJobStore,
  engine: ContainerEngine,
  config: ContainerJobConfig,
): Promise<ContainerJobOutcome> {
  const job = store.get(config.jobId);
  if (!job || job.lease?.leaseId !== config.leaseId) {
    return { jobId: config.jobId, ranContainer: false, trace: 'job not leased by this runner' };
  }

  const mountPath = config.mountPath ?? '/workspace';
  const workspace = await engine.prepareWorkspace(config.jobId, job.request.taskPayload, job.request.repoSlug);
  store.heartbeat(config.jobId, config.leaseId);

  let run: ContainerRunResult | undefined;
  let cleanup: ContainerCleanupProof;
  let finalizeResult: JobUpdateResult | undefined;
  try {
    if (!workspace.clone.ok) {
      finalizeResult = store.fail(
        config.jobId,
        config.leaseId,
        `repo clone failed: ${workspace.clone.error ?? 'unknown error'}`,
      );
    } else {
      try {
        run = await engine.run({
          jobId: config.jobId,
          image: config.image,
          command: config.command,
          workspaceHostPath: workspace.hostPath,
          mountPath,
          timeoutMs: config.timeoutMs,
        });
        const success = run.exitCode === 0 && !run.timedOut;
        if (success) {
          finalizeResult = store.complete(config.jobId, config.leaseId, `container exited 0 (${run.containerName})`);
        } else {
          const why = run.timedOut ? `timed out after ${config.timeoutMs}ms` : `exit ${run.exitCode}`;
          finalizeResult = store.fail(config.jobId, config.leaseId, `container ${why}: ${run.logs.slice(0, 500)}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finalizeResult = store.fail(config.jobId, config.leaseId, `container run error: ${message}`);
      }
    }
  } finally {
    cleanup = await engine.remove(config.jobId, workspace.hostPath);
    store.recordCleanup(config.jobId, cleanup.evidence);
  }

  const finalJob = store.get(config.jobId);
  const outcome = finalJob?.result?.outcome;
  const finalizeNote = finalizeResult && !finalizeResult.ok ? ` (finalize rejected: ${finalizeResult.reason})` : '';
  const cloneNote = workspace.clone.ok
    ? `cloned ${job.request.repoSlug}@${workspace.clone.commit ?? 'none'}`
    : 'clone failed';
  const runNote = run
    ? `ran ${run.containerName} exit ${run.exitCode}`
    : workspace.clone.ok
      ? 'run error'
      : 'skipped run';
  return {
    jobId: config.jobId,
    ranContainer: run !== undefined,
    containerName: run?.containerName,
    exitCode: run?.exitCode,
    outcome,
    result: finalJob?.result ?? undefined,
    cleanup,
    workspaceCommit: workspace.clone.commit,
    trace: `leased -> ${cloneNote} -> ${runNote} -> ${outcome ?? 'unknown'}${finalizeNote} -> cleaned`,
  };
}
