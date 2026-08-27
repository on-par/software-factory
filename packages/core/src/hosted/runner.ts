// src/hosted/runner.ts — Fake local runner orchestrator for hosted-exec (#898,
// parent #895/#897). Drives register -> poll -> heartbeat -> complete using
// only HostedJobStore methods; no clock, no I/O, no Docker, no real agent.
//
// runDockerRunner (#930) is the real counterpart: it drives register -> poll
// -> prepare workspace -> run the leased job through the existing
// ContainerEngine Docker path while posting periodic running-state
// heartbeats, then hands back the captured exit code/output for a later
// terminal-reporting slice to finalize. It deliberately never calls
// store.complete/store.fail or engine.remove — finalizing and cleanup are out
// of scope for this ticket.
import type { HostedJobResult } from '@on-par/contracts';

import type { ContainerEngine, ContainerRunResult } from './container.js';
import {
  redactGitHubCredential,
  resolveHostedAuthority,
  type GitHubAuthorityBrokerOptions,
} from './github-authority.js';
import type { HostedJobStore, StoredRunner } from './store.js';

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
  /** False when the job was never leased, or the workspace clone failed before the container ran. */
  ranContainer: boolean;
  containerName?: string;
  /** Docker process exit code, captured for the later terminal-reporting slice. */
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
 * observe. Captures the container's exit code and a bounded log tail for a
 * later terminal-reporting slice — it never calls store.complete/store.fail
 * and never removes the container or workspace; finalizing and cleanup stay
 * out of scope here. No clock of its own: heartbeat cadence comes from a real
 * interval timer, and the container run itself comes from the injected
 * engine, so tests drive both deterministically (fake timers + a fake
 * engine). */
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

  if (!workspace.clone.ok) {
    return {
      runner: getRunnerOrThrow(),
      leased: true,
      jobId,
      heartbeats,
      ranContainer: false,
      cloneError: redact(workspace.clone.error ?? 'unknown clone error'),
      workspaceHostPath: workspace.hostPath,
      trace: `registered -> leased ${jobId} -> ${heartbeats} heartbeats -> clone failed -> awaiting terminal report`,
    };
  }

  const timer = setInterval(beat, config.heartbeatIntervalMs);
  let run: ContainerRunResult;
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

  return {
    runner: getRunnerOrThrow(),
    leased: true,
    jobId,
    heartbeats,
    ranContainer: true,
    containerName: run.containerName,
    exitCode: run.exitCode,
    logsTail: redact(logTail(run.logs)),
    timedOut: run.timedOut,
    workspaceHostPath: workspace.hostPath,
    workspaceCommit: workspace.clone.commit,
    trace: redact(
      `registered -> leased ${jobId} -> ${heartbeats} heartbeats -> container ${run.containerName} exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''} -> awaiting terminal report`,
    ),
  };
}
