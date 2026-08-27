// src/hosted/runner.ts — Fake local runner orchestrator for hosted-exec (#898,
// parent #895/#897). Drives register -> poll -> heartbeat -> complete using
// only HostedJobStore methods; no clock, no I/O, no Docker, no real agent.
//
// runDockerRunner (#930/#931) is the real counterpart: it drives register ->
// poll -> prepare workspace -> run the leased job through the existing
// ContainerEngine Docker path while posting periodic running-state heartbeats,
// then finalizes the job and records cleanup proof before exiting.
import type { HostedJobOutcome, HostedJobResult } from '@on-par/contracts';

import type { ContainerCleanupProof, ContainerEngine, ContainerRunResult } from './container.js';
import {
  redactGitHubCredential,
  resolveHostedAuthority,
  type GitHubAuthorityBrokerOptions,
} from './github-authority.js';
import type { HostedJobStore, JobUpdateResult, StoredRunner } from './store.js';

/** Bound on the retained log tail — enough for diagnosis without unbounded growth. */
const LOG_TAIL_LIMIT = 2000;
const logTail = (logs: string): string => logs.slice(-LOG_TAIL_LIMIT);

export interface FakeRunnerConfig {
  runnerId: string;
  capabilities: string[];
  leaseId: string;
  ttlMs: number;
  heartbeatIntervalMs: number;
  /** Number of heartbeats to emit during fake no-op work (default 1). */
  heartbeats?: number;
  /** Force a failure result instead of completion (default false). */
  fail?: boolean;
}

export interface FakeRunnerOutcome {
  runner: StoredRunner;
  leased: boolean;
  jobId?: string;
  result?: HostedJobResult;
  trace: string;
}

export function runFakeRunner(store: HostedJobStore, config: FakeRunnerConfig): FakeRunnerOutcome {
  store.registerRunner({ runnerId: config.runnerId, capabilities: config.capabilities });

  const poll = store.pollForLease({
    runnerId: config.runnerId,
    capabilities: config.capabilities,
    leaseId: config.leaseId,
    ttlMs: config.ttlMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });

  if (!poll.ok) {
    const runner = store.getRunner(config.runnerId);
    if (!runner) {
      throw new Error(`hosted runner disappeared after registration: ${config.runnerId}`);
    }
    return { runner, leased: false, trace: 'no compatible job to lease' };
  }

  const jobId = poll.job.request.jobId;
  const heartbeats = config.heartbeats ?? 1;
  for (let i = 0; i < heartbeats; i += 1) {
    store.heartbeat(jobId, config.leaseId);
  }

  const finalized = config.fail
    ? store.fail(jobId, config.leaseId, 'fake runner reported failure')
    : store.complete(jobId, config.leaseId, 'fake runner completed no-op work');

  const result = finalized.ok ? (finalized.job.result ?? undefined) : undefined;
  const runner = store.getRunner(config.runnerId);
  if (!runner) {
    throw new Error(`hosted runner disappeared after registration: ${config.runnerId}`);
  }

  return {
    runner,
    leased: true,
    jobId,
    result,
    trace: `registered -> leased ${jobId} -> ${heartbeats} heartbeats -> ${config.fail ? 'failed' : 'completed'}`,
  };
}

export interface DockerRunnerConfig {
  runnerId: string;
  capabilities: string[];
  leaseId: string;
  ttlMs: number;
  heartbeatIntervalMs: number;
  image: string;
  command: string[];
  /** default '/workspace' */
  mountPath?: string;
  timeoutMs: number;
  /** When set, brokers a per-job GitHub credential (#901) gated by FACTORY_HOSTED_EXEC. */
  authority?: GitHubAuthorityBrokerOptions;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface DockerRunnerOutcome {
  runner: StoredRunner;
  leased: boolean;
  jobId?: string;
  /** Number of running-state heartbeats posted to the control plane. */
  heartbeats: number;
  /** True when the store accepted the terminal complete/fail update. */
  terminalReported: boolean;
  outcome?: HostedJobOutcome;
  result?: HostedJobResult;
  cleanup?: ContainerCleanupProof;
  cleanupError?: string;
  finalizeRejected?: string;
  /** False when the job was never leased, or the workspace clone failed before the container ran. */
  ranContainer: boolean;
  containerName?: string;
  /** Docker process exit code. */
  exitCode?: number;
  /** Bounded tail of combined stdout+stderr, secret-redacted. */
  logsTail?: string;
  timedOut?: boolean;
  /** Redacted clone failure reason, when the workspace could not be prepared. */
  cloneError?: string;
  workspaceHostPath?: string;
  workspaceCommit?: string;
  trace: string;
}

/** Runs a leased job through the existing Docker ContainerEngine path (#899)
 * while posting periodic running-state heartbeats for the control plane to
 * observe. Reports the terminal result, records cleanup proof, and returns the
 * terminal outcome. No clock of its own: heartbeat cadence comes from a real
 * interval timer, and the container run itself comes from the injected engine,
 * so tests drive both deterministically (fake timers + a fake engine). */
export async function runDockerRunner(
  store: HostedJobStore,
  engine: ContainerEngine,
  config: DockerRunnerConfig,
): Promise<DockerRunnerOutcome> {
  store.registerRunner({ runnerId: config.runnerId, capabilities: config.capabilities });

  const poll = store.pollForLease({
    runnerId: config.runnerId,
    capabilities: config.capabilities,
    leaseId: config.leaseId,
    ttlMs: config.ttlMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });

  const getRunnerOrThrow = (): StoredRunner => {
    const runner = store.getRunner(config.runnerId);
    if (!runner) {
      throw new Error(`hosted runner disappeared after registration: ${config.runnerId}`);
    }
    return runner;
  };

  if (!poll.ok) {
    return {
      runner: getRunnerOrThrow(),
      leased: false,
      heartbeats: 0,
      terminalReported: false,
      ranContainer: false,
      trace: 'no compatible job to lease',
    };
  }

  const jobId = poll.job.request.jobId;
  const credential = config.authority
    ? await resolveHostedAuthority(config.env ?? process.env, poll.job, config.authority)
    : null;
  const redact = (text: string): string => (credential ? redactGitHubCredential(text, credential) : text);

  const workspace = await engine.prepareWorkspace(
    jobId,
    poll.job.request.taskPayload,
    poll.job.request.repoSlug,
    credential ?? undefined,
  );

  let heartbeats = 0;
  const beat = (): void => {
    store.heartbeat(jobId, config.leaseId);
    heartbeats += 1;
  };
  beat();

  let run: ContainerRunResult | undefined;
  let cleanup: ContainerCleanupProof | undefined;
  let cleanupError: string | undefined;
  let finalizeResult: JobUpdateResult | undefined;
  try {
    if (!workspace.clone.ok) {
      finalizeResult = store.fail(
        jobId,
        config.leaseId,
        redact(`repo clone failed: ${workspace.clone.error ?? 'unknown error'}`),
        { failurePhase: 'clone' },
      );
    } else {
      const timer = setInterval(beat, config.heartbeatIntervalMs);
      try {
        run = await engine.run({
          jobId,
          image: config.image,
          command: config.command,
          workspaceHostPath: workspace.hostPath,
          mountPath: config.mountPath ?? '/workspace',
          timeoutMs: config.timeoutMs,
        });
      } finally {
        clearInterval(timer);
      }

      const redactedLogs = redact(logTail(run.logs));
      const success = run.exitCode === 0 && !run.timedOut;
      if (success) {
        finalizeResult = store.complete(jobId, config.leaseId, `container exited 0 (${run.containerName})`, {
          exitCode: run.exitCode,
          logsTail: redactedLogs,
          artifacts: run.artifacts,
        });
      } else {
        const why = run.timedOut ? `timed out after ${config.timeoutMs}ms` : `exit ${run.exitCode}`;
        finalizeResult = store.fail(jobId, config.leaseId, redact(`container ${why}`), {
          failurePhase: 'run',
          exitCode: run.exitCode,
          logsTail: redactedLogs,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finalizeResult = store.fail(jobId, config.leaseId, redact(`container run error: ${message}`), {
      failurePhase: 'run',
    });
  } finally {
    try {
      cleanup = await engine.remove(jobId, workspace.hostPath);
      store.recordCleanup(jobId, redact(cleanup.evidence));
    } catch (err) {
      cleanupError = redact(err instanceof Error ? err.message : String(err));
    }
  }

  const finalJob = store.get(jobId);
  const outcome = finalJob?.result?.outcome;
  const finalizeRejected = finalizeResult && !finalizeResult.ok ? finalizeResult.reason : undefined;
  const runNote = run
    ? `container ${run.containerName} exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}`
    : workspace.clone.ok
      ? 'run error'
      : 'clone failed';
  const cleanupNote = cleanupError ? `cleanup failed: ${cleanupError}` : 'cleaned';
  return {
    runner: getRunnerOrThrow(),
    leased: true,
    jobId,
    heartbeats,
    terminalReported: finalizeResult?.ok ?? false,
    outcome,
    result: finalJob?.result ?? undefined,
    cleanup,
    cleanupError,
    finalizeRejected,
    ranContainer: run !== undefined,
    containerName: run?.containerName,
    exitCode: run?.exitCode,
    logsTail: run ? redact(logTail(run.logs)) : undefined,
    timedOut: run?.timedOut,
    cloneError: !workspace.clone.ok ? redact(workspace.clone.error ?? 'unknown clone error') : undefined,
    workspaceHostPath: workspace.hostPath,
    workspaceCommit: workspace.clone.commit,
    trace: redact(
      `registered -> leased ${jobId} -> ${heartbeats} heartbeats -> ${runNote} -> ${outcome ?? 'unknown'}${finalizeRejected ? ` (finalize rejected: ${finalizeRejected})` : ''} -> ${cleanupNote}`,
    ),
  };
}
