// src/hosted/summary.ts — Pure operator-facing summary of a hosted job (#902,
// parent #895/#897). Reads only the retained StoredHostedJob record: no I/O,
// no clock, no secrets. This is the CLI/dashboard surface for "what happened
// to this job" without SSHing into the runner.
import type {
  HostedArtifactRef,
  HostedJobEvent,
  HostedJobOutcome,
  HostedJobPhase,
  HostedJobStatus,
} from '@on-par/contracts';

import type { StoredHostedJob } from './store.js';

export interface HostedJobSummary {
  jobId: string;
  repoSlug: string;
  status: HostedJobStatus;
  /** runnerId currently holding the active lease, else null. */
  leasedBy: string | null;
  outcome: HostedJobOutcome | null;
  summary: string | null;
  exitCode: number | null;
  failurePhase: HostedJobPhase | null;
  eventCount: number;
  lastEvent: HostedJobEvent | null;
  artifacts: HostedArtifactRef[];
  artifactCount: number;
  logsTail: string | null;
  /** Message of the last 'cleaned' event, else null. */
  cleanupProof: string | null;
  updatedAt: string;
}

/** Maps a stored job to an operator-facing summary. Exposes no secrets: only
 * metadata already present on the retained record (result/events). */
export function summarizeHostedJob(job: StoredHostedJob): HostedJobSummary {
  const artifacts = job.result?.artifacts ?? [];
  const cleaned = [...job.events].reverse().find((event) => event.type === 'cleaned');
  return {
    jobId: job.request.jobId,
    repoSlug: job.request.repoSlug,
    status: job.request.status,
    leasedBy: job.lease?.runnerId ?? null,
    outcome: job.result?.outcome ?? null,
    summary: job.result?.summary ?? null,
    exitCode: job.result?.exitCode ?? null,
    failurePhase: job.result?.failurePhase ?? null,
    eventCount: job.events.length,
    lastEvent: job.events.at(-1) ?? null,
    artifacts,
    artifactCount: artifacts.length,
    logsTail: job.result?.logsTail ?? null,
    cleanupProof: cleaned?.message ?? null,
    updatedAt: job.updatedAt,
  };
}

export function summarizeHostedJobs(jobs: StoredHostedJob[]): HostedJobSummary[] {
  return jobs.map(summarizeHostedJob);
}
