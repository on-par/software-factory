// src/hosted/smoke.ts — Local end-to-end hosted-exec smoke orchestrator (#923,
// parent #895). Composes the already-proven building blocks (store, container
// runner, summary) into one optimistic-path run: create -> lease -> disposable
// Docker run against a fresh clone -> terminal result -> cleanup proof. Gated
// by FACTORY_HOSTED_EXEC so the default-off local factory path is untouched.
// No clock, fs, network, or Docker are touched directly — determinism comes
// from the injected engine and the injected clock.
import { hostedExecEnabled } from '@on-par/contracts';

import { runContainerJob, type ContainerEngine, type ContainerJobOutcome } from './container.js';
import { summarizeHostedJob, type HostedJobSummary } from './summary.js';
import { createHostedJobStore, type HostedClock } from './store.js';

export interface HostedSmokeConfig {
  repoSlug: string;
  image: string;
  command: string[];
  now: HostedClock;
  /** default 'smoke-job-1' */
  jobId?: string;
  /** default 'smoke-runner-1' */
  runnerId?: string;
  /** default 'smoke-lease-1' */
  leaseId?: string;
  /** default ['git', 'node'] */
  capabilities?: string[];
  /** default 'repo:read' */
  requiredAuthority?: string;
  /** default 'hosted-exec smoke: run a minimal factory-safe command' */
  taskPayload?: string;
  /** default 300_000 */
  ttlMs?: number;
  /** default 30_000 */
  heartbeatIntervalMs?: number;
  /** default 120_000 */
  timeoutMs?: number;
  /** default '/workspace' */
  mountPath?: string;
  /** Injectable for tests; defaults to process.env for the gate. */
  env?: NodeJS.ProcessEnv;
}

export interface HostedSmokeOutcome {
  enabled: boolean;
  trace: string;
  jobId?: string;
  leaseId?: string;
  job?: ContainerJobOutcome;
  summary?: HostedJobSummary;
}

/** Runs the optimistic hosted-exec path against a real (injected) container
 * engine: creates a job, registers a runner, leases it, drives a disposable
 * container run against a fresh clone, then summarizes the terminal result.
 * Brokers no real credential — authority minting is out of scope for the
 * smoke run (#923). */
export async function runHostedSmoke(engine: ContainerEngine, config: HostedSmokeConfig): Promise<HostedSmokeOutcome> {
  if (!hostedExecEnabled(config.env ?? process.env)) {
    return { enabled: false, trace: 'hosted execution disabled — local factory path unchanged' };
  }

  const jobId = config.jobId ?? 'smoke-job-1';
  const runnerId = config.runnerId ?? 'smoke-runner-1';
  const leaseId = config.leaseId ?? 'smoke-lease-1';
  const capabilities = config.capabilities ?? ['git', 'node'];
  const requiredAuthority = config.requiredAuthority ?? 'repo:read';
  const taskPayload = config.taskPayload ?? 'hosted-exec smoke: run a minimal factory-safe command';
  const ttlMs = config.ttlMs ?? 300_000;
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
  const timeoutMs = config.timeoutMs ?? 120_000;
  const mountPath = config.mountPath ?? '/workspace';

  const store = createHostedJobStore({ now: config.now });
  store.create({
    jobId,
    repoSlug: config.repoSlug,
    taskPayload,
    requiredCapabilities: capabilities,
    requiredAuthority,
  });
  store.registerRunner({ runnerId, capabilities });

  const lease = store.acquireLease({ jobId, runnerId, leaseId, ttlMs, heartbeatIntervalMs });
  if (!lease.ok) {
    return { enabled: true, jobId, trace: `lease failed: ${lease.reason}` };
  }

  const job = await runContainerJob(store, engine, {
    jobId,
    leaseId,
    image: config.image,
    command: config.command,
    mountPath,
    timeoutMs,
  });

  const finalJob = store.get(jobId);
  const summary = finalJob ? summarizeHostedJob(finalJob) : undefined;

  return { enabled: true, jobId, leaseId, job, summary, trace: `smoke: ${job.trace}` };
}
