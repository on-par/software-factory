import { z } from 'zod';

const loosePayloadSchema = z.object({}).catchall(z.any());

export const statusJsonSchema = z.object({
  schemaVersion: z.literal(1),
  repo: z.string(),
  product: z.string().nullable(),
  stop: z.boolean(),
  stopInfo: z
    .object({
      source: z.enum(['manual', 'usage-watchdog', 'self-update', 'unknown']),
      setAt: z.string().nullable(),
    })
    .nullable(),
  breaker: z.object({
    open: z.boolean(),
    providers: z.array(
      z.object({
        provider: z.string(),
        reason: z.string(),
        openedAt: z.string(),
        remainingSec: z.number(),
      }),
    ),
  }),
  active: z.array(
    z.object({
      lane: z.string(),
      issue: z.number(),
      phase: z.string(),
      ageSec: z.number(),
    }),
  ),
  update: z
    .object({
      mode: z.enum(['manual', 'stable', 'prerelease']),
      channel: z.enum(['latest', 'next']).nullable(),
      installKind: z.enum(['npm-global', 'source', 'unknown']),
      current: z.string(),
      available: z.string().nullable(),
      lastCheckAt: z.string().nullable(),
      lastResult: z
        .object({
          at: z.string(),
          version: z.string(),
          outcome: z.enum(['updated', 'rolled-back', 'failed', 'skipped']),
          error: z.string().optional(),
        })
        .nullable(),
      draining: z
        .object({
          since: z.string(),
          target: z.string(),
          stopFiles: z.array(z.string()).optional(),
        })
        .nullable(),
    })
    .nullable(),
});

export const logsLineJsonSchema = z.object({
  ts: z.string(),
  type: z.string(),
  issue: z.string(),
  msg: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  lane: z.string().optional(),
  repo: z.string().optional(),
  phase: z.string().optional(),
  actor: z.string().optional(),
  failoverReason: z.string().optional(),
  fingerprint: z.string().optional(),
  evidence: loosePayloadSchema.optional(),
  rework: loosePayloadSchema.optional(),
  readiness: loosePayloadSchema.optional(),
  queueReprioritization: loosePayloadSchema.optional(),
  prClassification: loosePayloadSchema.optional(),
  lanePaused: loosePayloadSchema.optional(),
  stewardTriggered: loosePayloadSchema.optional(),
  flakyTests: loosePayloadSchema.optional(),
  checkFailure: loosePayloadSchema.optional(),
  ciFailure: loosePayloadSchema.optional(),
  model: z.string().optional(),
  tokens: z.object({ input: z.number(), output: z.number() }).optional(),
  durationMs: z.number().optional(),
  cursor: z.string().optional(),
});

export type StatusJson = z.infer<typeof statusJsonSchema>;
export type LogsLineJson = z.infer<typeof logsLineJsonSchema>;
