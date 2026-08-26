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

export const HostedJobEventTypeSchema = z.enum([
  'requested',
  'leased',
  'heartbeat',
  'completed',
  'failed',
  'expired',
  'cleaned',
]);
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

export const HostedJobPhaseSchema = z.enum(['clone', 'run', 'cleanup']);
export type HostedJobPhase = z.infer<typeof HostedJobPhaseSchema>;

/** Metadata-only reference to a produced artifact — never inline content or a
 * secret value. `ref` is an opaque retained handle (a path or store handle). */
export const HostedArtifactRefSchema = z.object({
  /** Display/logical name, e.g. 'build.log', 'coverage'. */
  name: z.string().min(1),
  /** Opaque retained reference — a path or store handle. NEVER inline content. */
  ref: z.string().min(1),
  /** e.g. 'log', 'report', 'patch'. */
  kind: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
});
export type HostedArtifactRef = z.infer<typeof HostedArtifactRefSchema>;

export const HostedJobOutcomeSchema = z.enum(['completed', 'failed']);
export const HostedJobResultSchema = z.object({
  jobId: z.string().min(1),
  outcome: HostedJobOutcomeSchema,
  summary: z.string().min(1),
  /** ISO-8601. */
  finishedAt: z.string(),
  /** Container/process exit code when a process ran. */
  exitCode: z.number().int().optional(),
  /** Phase reached when the job failed — diagnosis aid. */
  failurePhase: HostedJobPhaseSchema.optional(),
  /** Bounded tail of recent logs; MUST already be secret-redacted by the caller. */
  logsTail: z.string().optional(),
  /** Metadata for produced artifacts; never inline content or secret values. */
  artifacts: z.array(HostedArtifactRefSchema).optional(),
});

export const ProviderKindSchema = z.enum(['codex-oauth', 'claude-code-oauth', 'opencode-go-oauth', 'pi-dev']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** A single piece of provider session material referenced by an opaque handle —
 * never the raw secret. The broker resolves `handle` to real material at mount
 * time; the handle is safe to persist in a job record. */
export const ProviderSecretRefSchema = z.object({
  /** Logical name inside the provider's session, e.g. 'oauth_token', 'refresh_token'. */
  name: z.string().min(1),
  /** Opaque broker handle; NEVER the secret value. */
  handle: z.string().min(1),
});
export type ProviderSecretRef = z.infer<typeof ProviderSecretRefSchema>;

/** A job-scoped bundle of provider session material. Scoped to exactly one job
 * (`jobId`) so it is never ambient/shared runner state, and holds only opaque
 * secret refs so raw OAuth material is never persisted. */
export const ProviderSessionBundleSchema = z.object({
  provider: ProviderKindSchema,
  jobId: z.string().min(1),
  /** Where the provider CLI expects its session dir inside the container, e.g. '/root/.codex'. */
  mountPath: z.string().min(1),
  secrets: z.array(ProviderSecretRefSchema).min(1),
});
export type ProviderSessionBundle = z.infer<typeof ProviderSessionBundleSchema>;

export type HostedJobStatus = z.infer<typeof HostedJobStatusSchema>;
export type HostedJobRequest = z.infer<typeof HostedJobRequestSchema>;
export type HostedJobEvent = z.infer<typeof HostedJobEventSchema>;
export type RunnerLease = z.infer<typeof RunnerLeaseSchema>;
export type HostedJobOutcome = z.infer<typeof HostedJobOutcomeSchema>;
export type HostedJobResult = z.infer<typeof HostedJobResultSchema>;

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
