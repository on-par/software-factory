// src/hosted/store.ts — In-memory, clock-injected control-plane store for
// hosted (remote-runner) execution jobs (#897, parent #895/#896). Enforces the
// idempotency invariants: one active lease per job, finalize only by the
// active lease holder, duplicate terminal updates are harmless and auditable,
// and an expired lease cannot mutate final state.
import {
  HostedJobEventSchema,
  HostedJobRequestSchema,
  RunnerLeaseSchema,
  type HostedJobEvent,
  type HostedJobEventSeveritySchema,
  type HostedJobEventTypeSchema,
  type HostedJobRequest,
  type RunnerLease,
} from '@on-par/contracts';
import type { z } from 'zod';

export type HostedClock = () => number;

export interface HostedJobStoreOptions {
  now: HostedClock;
}

export interface StoredHostedJob {
  request: HostedJobRequest;
  lease: RunnerLease | null;
  events: HostedJobEvent[];
  updatedAt: string;
}

export interface CreateHostedJobInput {
  jobId: string;
  repoSlug: string;
  taskPayload: string;
  requiredCapabilities: string[];
  requiredAuthority: string;
}

export interface AcquireLeaseInput {
  jobId: string;
  runnerId: string;
  leaseId: string;
  ttlMs: number;
  heartbeatIntervalMs: number;
}

export type LeaseRejectionReason = 'job-not-found' | 'job-terminal' | 'lease-held';
export type JobLeaseResult =
  | { ok: true; lease: RunnerLease; job: StoredHostedJob }
  | { ok: false; reason: LeaseRejectionReason; job?: StoredHostedJob };

export type UpdateRejectionReason = 'job-not-found' | 'lease-mismatch' | 'lease-expired';
export type JobUpdateResult =
  | { ok: true; job: StoredHostedJob; alreadyTerminal: boolean }
  | { ok: false; reason: UpdateRejectionReason; job?: StoredHostedJob };

export interface HostedJobStore {
  create(input: CreateHostedJobInput): StoredHostedJob;
  get(jobId: string): StoredHostedJob | undefined;
  list(): StoredHostedJob[];
  acquireLease(input: AcquireLeaseInput): JobLeaseResult;
  heartbeat(jobId: string, leaseId: string): JobUpdateResult;
  complete(jobId: string, leaseId: string): JobUpdateResult;
  fail(jobId: string, leaseId: string, reason: string): JobUpdateResult;
}

type HostedJobEventType = z.infer<typeof HostedJobEventTypeSchema>;
type HostedJobEventSeverity = z.infer<typeof HostedJobEventSeveritySchema>;

function isTerminal(status: HostedJobRequest['status']): boolean {
  return status === 'done' || status === 'failed';
}

function isLeaseActive(job: StoredHostedJob, leaseId: string, nowMs: number): boolean {
  return job.lease !== null && job.lease.leaseId === leaseId && nowMs < Date.parse(job.lease.expiresAt);
}

export function createHostedJobStore(options: HostedJobStoreOptions): HostedJobStore {
  const { now } = options;
  const jobs = new Map<string, StoredHostedJob>();
  const iso = (ms: number) => new Date(ms).toISOString();

  function appendEvent(
    job: StoredHostedJob,
    type: HostedJobEventType,
    severity: HostedJobEventSeverity,
    message: string,
  ): void {
    const event = HostedJobEventSchema.parse({
      jobId: job.request.jobId,
      type,
      ts: iso(now()),
      severity,
      message,
    });
    job.events.push(event);
    job.updatedAt = iso(now());
  }

  function resolveMutableJob(jobId: string, leaseId: string): { job: StoredHostedJob } | { result: JobUpdateResult } {
    const job = jobs.get(jobId);
    if (!job) {
      return { result: { ok: false, reason: 'job-not-found' } };
    }
    if (isTerminal(job.request.status)) {
      appendEvent(job, job.request.status === 'done' ? 'completed' : 'failed', 'warn', 'ignored: job already terminal');
      return { result: { ok: true, job, alreadyTerminal: true } };
    }
    if (job.lease?.leaseId !== leaseId) {
      return { result: { ok: false, reason: 'lease-mismatch', job } };
    }
    if (!isLeaseActive(job, leaseId, now())) {
      return { result: { ok: false, reason: 'lease-expired', job } };
    }
    return { job };
  }

  return {
    create(input) {
      if (jobs.has(input.jobId)) {
        throw new Error(`hosted job already exists: ${input.jobId}`);
      }
      const request = HostedJobRequestSchema.parse({
        ...input,
        status: 'requested',
        createdAt: iso(now()),
      });
      const job: StoredHostedJob = { request, lease: null, events: [], updatedAt: request.createdAt };
      appendEvent(job, 'requested', 'info', 'hosted job requested');
      jobs.set(input.jobId, job);
      return job;
    },

    get(jobId) {
      return jobs.get(jobId);
    },

    list() {
      return [...jobs.values()];
    },

    acquireLease(input) {
      const job = jobs.get(input.jobId);
      if (!job) {
        return { ok: false, reason: 'job-not-found' };
      }
      if (isTerminal(job.request.status)) {
        return { ok: false, reason: 'job-terminal', job };
      }
      if (job.lease !== null && isLeaseActive(job, job.lease.leaseId, now())) {
        return { ok: false, reason: 'lease-held', job };
      }
      const lease = RunnerLeaseSchema.parse({
        runnerId: input.runnerId,
        leaseId: input.leaseId,
        jobId: input.jobId,
        expiresAt: iso(now() + input.ttlMs),
        heartbeatIntervalMs: input.heartbeatIntervalMs,
      });
      job.lease = lease;
      job.request.status = 'leased';
      appendEvent(job, 'leased', 'info', 'lease acquired');
      return { ok: true, lease, job };
    },

    heartbeat(jobId, leaseId) {
      const resolved = resolveMutableJob(jobId, leaseId);
      if ('result' in resolved) {
        return resolved.result;
      }
      const { job } = resolved;
      if (job.request.status === 'leased') {
        job.request.status = 'running';
      }
      appendEvent(job, 'heartbeat', 'info', 'heartbeat received');
      return { ok: true, job, alreadyTerminal: false };
    },

    complete(jobId, leaseId) {
      const resolved = resolveMutableJob(jobId, leaseId);
      if ('result' in resolved) {
        return resolved.result;
      }
      const { job } = resolved;
      job.request.status = 'done';
      appendEvent(job, 'completed', 'info', 'hosted job completed');
      return { ok: true, job, alreadyTerminal: false };
    },

    fail(jobId, leaseId, reason) {
      const resolved = resolveMutableJob(jobId, leaseId);
      if ('result' in resolved) {
        return resolved.result;
      }
      const { job } = resolved;
      job.request.status = 'failed';
      appendEvent(job, 'failed', 'error', `hosted job failed: ${reason}`);
      return { ok: true, job, alreadyTerminal: false };
    },
  };
}
