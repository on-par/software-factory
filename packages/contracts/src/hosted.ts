// src/hosted.ts — Hosted (remote-runner) execution contract: shared vocabulary and
// off-by-default safety switch for the hosted-exec architecture (#896, parent #895).
import { z } from 'zod';

export const HOSTED_EXEC_FLAG = 'FACTORY_HOSTED_EXEC';

export const HostedJobStatusSchema = z.enum(['requested', 'leased', 'running', 'done', 'failed']);

export const HostedJobRequestSchema = z.object({
  jobId: z.string().min(1),
  /** "owner/repo" */
  repoSlug: z.string().min(1),
  /** Opaque task description. */
  taskPayload: z.string().min(1),
  requiredCapabilities: z.array(z.string().min(1)),
  requiredAuthority: z.string().min(1),
  status: HostedJobStatusSchema,
  /** ISO-8601. */
  createdAt: z.string(),
});

export const HostedJobEventTypeSchema = z.enum(['requested', 'leased', 'heartbeat', 'completed', 'failed']);
export const HostedJobEventSeveritySchema = z.enum(['info', 'warn', 'error']);

export const HostedJobEventSchema = z.object({
  jobId: z.string().min(1),
  type: HostedJobEventTypeSchema,
  /** ISO-8601. */
  ts: z.string(),
  severity: HostedJobEventSeveritySchema,
  message: z.string().min(1),
});

export const RunnerLeaseSchema = z.object({
  runnerId: z.string().min(1),
  leaseId: z.string().min(1),
  jobId: z.string().min(1),
  /** ISO-8601 expiry. */
  expiresAt: z.string(),
  /** Heartbeat expectation. */
  heartbeatIntervalMs: z.number().int().positive(),
});

export type HostedJobStatus = z.infer<typeof HostedJobStatusSchema>;
export type HostedJobRequest = z.infer<typeof HostedJobRequestSchema>;
export type HostedJobEvent = z.infer<typeof HostedJobEventSchema>;
export type RunnerLease = z.infer<typeof RunnerLeaseSchema>;

/** True only when the flag is exactly '1' — every other/absent value is off (default off). */
export function hostedExecEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOSTED_EXEC_FLAG] === '1';
}

export interface HostedContractDemoResult {
  enabled: boolean;
  trace: string;
  request?: HostedJobRequest;
  event?: HostedJobEvent;
  lease?: RunnerLease;
}

/** Fixed literal timestamp — this is a contract proof, not a live run, so the
 * output is deterministic and no clock is read. */
const DEMO_TS = '2026-01-01T00:00:00.000Z';

/** Pure demo: job requested -> event emitted -> runner leaseable. Constructs
 * nothing when the flag is off — no fs, no network, no child_process, no Docker. */
export function runHostedContractDemo(env: NodeJS.ProcessEnv = process.env): HostedContractDemoResult {
  if (!hostedExecEnabled(env)) {
    return { enabled: false, trace: 'hosted execution disabled — local path unchanged' };
  }
  const request = HostedJobRequestSchema.parse({
    jobId: 'demo-job-1',
    repoSlug: 'on-par/software-factory',
    taskPayload: 'demo: prove the hosted contract path',
    requiredCapabilities: ['git', 'node'],
    requiredAuthority: 'repo:write',
    status: 'requested',
    createdAt: DEMO_TS,
  });
  const event = HostedJobEventSchema.parse({
    jobId: request.jobId,
    type: 'requested',
    ts: DEMO_TS,
    severity: 'info',
    message: 'hosted job requested',
  });
  const lease = RunnerLeaseSchema.parse({
    runnerId: 'demo-runner-1',
    leaseId: 'demo-lease-1',
    jobId: request.jobId,
    expiresAt: DEMO_TS,
    heartbeatIntervalMs: 30_000,
  });
  return {
    enabled: true,
    request,
    event,
    lease,
    trace: 'job requested -> event emitted -> runner leaseable',
  };
}
