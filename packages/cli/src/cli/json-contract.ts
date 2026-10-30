import { z } from 'zod';

const loosePayloadSchema = z.object({}).catchall(z.any());

/** Open draft PRs on factory branches (#3553); null when the PR listing was unreadable. */
export const openFactoryDraftsJsonSchema = z
  .object({ count: z.number(), oldestHours: z.number().nullable() })
  .nullable();

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
        until: z.literal('credentials-change').optional(),
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
  openFactoryDrafts: openFactoryDraftsJsonSchema,
  decomposedParents: z
    .array(
      z.object({
        issue: z.number(),
        covered: z.number(),
        total: z.number(),
        fullyCovered: z.boolean(),
        uncovered: z.array(z.object({ id: z.string(), text: z.string() })),
      }),
    )
    .meta({
      deprecated: true,
      description: 'Deprecated: always an empty array. A later release removes this field (#3834).',
    }),
  disk: z.object({ freeGb: z.number(), thresholdGb: z.number(), low: z.boolean() }).nullable(),
  providers: z.array(
    z.object({
      id: z.string(),
      plan: z.enum(['subscription', 'api', 'unknown']),
      breaker: z.enum(['closed', 'open']),
      openedReason: z.string().nullable(),
      openedAt: z.string().nullable(),
      resetAt: z.string().optional(),
    }),
  ),
  activeAlerts: z.array(
    z.object({
      kind: z.enum(['provider_auth_rejected', 'all_providers_down']),
      provider: z.string().optional(),
      stage: z.enum(['plan', 'build']).optional(),
      since: z.string(),
      detail: z.string(),
    }),
  ),
});

/** `factory kpis --json` (#3553). */
export const kpisJsonSchema = z.object({
  schemaVersion: z.literal(1),
  kpis: loosePayloadSchema,
  openFactoryDrafts: openFactoryDraftsJsonSchema,
});

export type KpisJson = z.infer<typeof kpisJsonSchema>;

export const logsLineJsonSchema = z.object({
  ts: z.string(),
  type: z.string(),
  issue: z.string(),
  msg: z.string(),
  paths: z.array(z.string()).optional(),
  mode: z.literal('mechanical').optional(),
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
  park: loosePayloadSchema.optional(),
  providerCapped: loosePayloadSchema.optional(),
  providerFailover: loosePayloadSchema.optional(),
  allProvidersDown: loosePayloadSchema.optional(),
  providerRefused: loosePayloadSchema.optional(),
  providerAuthRejected: loosePayloadSchema.optional(),
  providerBreakerClose: loosePayloadSchema.optional(),
  providerRestored: loosePayloadSchema.optional(),
  claimLost: loosePayloadSchema.optional(),
  stewardTriggered: loosePayloadSchema.optional(),
  flakyTests: loosePayloadSchema.optional(),
  attribution: loosePayloadSchema.optional(),
  checkFailure: loosePayloadSchema.optional(),
  ciFailure: loosePayloadSchema.optional(),
  escalateKind: z.enum(['missing-info', 'contradiction', 'split']).optional(),
  model: z.string().optional(),
  tokens: z.object({ input: z.number(), output: z.number() }).optional(),
  durationMs: z.number().optional(),
  cursor: z.string().optional(),
});

export const daemonLoadJsonSchema = z.object({
  activeRuns: z.number().int().nonnegative().nullable(),
  maxSlots: z.number().int().positive().nullable(),
  queueDepth: z.number().int().nonnegative().nullable(),
});

export const daemonStatusJsonSchema = z.object({
  schemaVersion: z.literal(1),
  running: z.boolean(),
  pid: z.number().nullable(),
  uptimeSec: z.number().nullable(),
  plistInstalled: z.boolean(),
  repos: z.array(
    z.object({
      slug: z.string(),
      checkoutPath: z.string(),
      state: z.enum(['active', 'paused', 'draining', 'detached']),
    }),
  ),
  load: daemonLoadJsonSchema,
});

export const queueListJsonSchema = z.object({
  schemaVersion: z.literal(1),
  lanes: z.array(
    z.object({
      lane: z.string(),
      items: z.array(
        z.object({
          issue: z.number(),
          title: z.string().optional(),
          status: z.enum(['queued', 'in-progress', 'parked']),
          order: z.number(),
          claimedBy: z.string().nullable(),
        }),
      ),
    }),
  ),
  orderConflicts: z.array(
    z.object({
      lane: z.string(),
      order: z.number().nullable(),
      issues: z.array(z.number()),
      reason: z.enum(['missing-order-label', 'multiple-order-labels', 'malformed-order-label']).optional(),
    }),
  ),
});

export const usageJsonSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['subscription', 'heuristic', 'unavailable']),
  utilizationPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  windowHours: z.number(),
  estimateUsd: z.number().nullable(),
  plan: z
    .enum(['subscription', 'api', 'unknown'])
    .describe(
      "How this machine profile's Claude Code is signed in: 'api' when ANTHROPIC_API_KEY is set (API key over login), 'subscription' for a stored Claude login, else 'unknown'. Detected from auth without reading a secret; a hint the client may override (#3214).",
    ),
});

export const costJsonSchema = z.object({
  schemaVersion: z.literal(1),
  rows: z.array(
    z.object({
      ts: z.string(),
      issue: z.string(),
      task: z.string(),
      model: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      rawInputTokens: z.number().nullable(),
      cacheReadTokens: z.number().nullable(),
      cacheCreationTokens: z.number().nullable(),
      cost: z.number().nullable(),
    }),
  ),
  perModel: z.array(
    z.object({
      model: z.string(),
      tasks: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      rawInputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheCreationTokens: z.number(),
      cost: z.number().nullable(),
      unpricedCount: z.number(),
      cachedRateMissingCount: z.number(),
    }),
  ),
  total: z.object({
    cost: z.number().nullable(),
    unpricedCount: z.number(),
    cachedRateMissingCount: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      rawInput: z.number(),
      cacheRead: z.number(),
      cacheCreation: z.number(),
    }),
  }),
});

export const runsJsonSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(
    z.object({
      issue: z.number(),
      lane: z.string().nullable(),
      repo: z.string().nullable(),
      status: z.string().nullable(),
      phase: z.enum(['plan', 'build', 'check', 'ship']).nullable(),
      branch: z.string().nullable(),
      prNumber: z.number().nullable(),
      model: z.string().nullable(),
      attempts: z.number().nullable(),
      startedAt: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
});

export const runDiffstatJsonSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.number(),
  branch: z.string().nullable(),
  base: z.string(),
  files: z
    .array(z.object({ path: z.string(), added: z.number().nullable(), deleted: z.number().nullable() }))
    .nullable(),
  totals: z.object({ files: z.number(), added: z.number(), deleted: z.number() }).nullable(),
  reason: z.enum(['branch-missing', 'base-missing', 'no-branch']).nullable(),
});

const orderCollisionSchema = z.object({ order: z.number(), heldBy: z.array(z.number()) });

export const queueAddJsonSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  action: z.literal('queue-add'),
  lane: z.string(),
  issues: z.array(
    z.object({
      number: z.number(),
      outcome: z.enum(['queued', 'already-queued', 'failed']),
      order: z.number().nullable(),
      labelsAdded: z.array(z.string()),
      detail: z.string().optional(),
      collision: orderCollisionSchema.optional(),
    }),
  ),
  labelsCreated: z.array(z.string()),
});

const stopResumeFields = {
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  repo: z.string(),
  stopFlag: z.object({ before: z.boolean(), after: z.boolean() }),
};

export const stopJsonSchema = z.object({ ...stopResumeFields, action: z.literal('stop') });
export const resumeJsonSchema = z.object({ ...stopResumeFields, action: z.literal('resume') });

export const unparkJsonSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  action: z.literal('unpark'),
  issue: z.number(),
  lane: z.string(),
  order: z.number(),
  collision: orderCollisionSchema.optional(),
  labelsBefore: z.array(z.string()),
  labelsAfter: z.array(z.string()),
});

const checkItemSchema = z.object({ aspect: z.string(), text: z.string() });

/** `factory check --json` (#3469). Heading-based fields, criteria, invest are advisory when the judge ran. */
export const checkJsonSchema = z.object({
  issue: z.number().int(),
  schemaVersion: z.literal(1),
  verdict: z.enum(['ready', 'ready-with-assumptions', 'not-ready']).nullable(),
  summary: z.string().nullable(),
  questions: z.array(checkItemSchema),
  assumptions: z.array(checkItemSchema),
  judge: z
    .object({
      model: z.string(),
      cost: z.number().nullable(),
      unpriced: z.boolean(),
      cached: z.boolean(),
      promptVersion: z.string(),
      bodyHash: z.string(),
    })
    .nullable(),
  judgeSkipped: z.literal('epic').optional(),
  template: z.string().describe('advisory'),
  score: z.number().describe('advisory'),
  fields: z.object({ pass: z.boolean(), missing: z.array(z.string()) }).describe('advisory'),
  criteria: z
    .object({
      findings: z.array(
        z.object({
          index: z.number().int(),
          text: z.string(),
          grade: z.enum(['structured', 'unstructured', 'empty']),
          observable: z.boolean(),
          note: z.string().optional(),
        }),
      ),
      verificationCommand: z.boolean().nullable(),
      problems: z.array(z.string()),
      pass: z.boolean(),
    })
    .nullable()
    .describe('advisory'),
  size: z.object({ verdict: z.enum(['runs-as-is', 'would-split']), reason: z.string().optional() }),
  invest: z
    .object({
      findings: z.array(
        z.object({
          letter: z.string(),
          status: z.enum(['pass', 'warn', 'not-checked']),
          reason: z.string(),
        }),
      ),
    })
    .nullable()
    .describe('advisory'),
  reasons: z.array(z.string()),
  exitCode: z.union([z.literal(0), z.literal(1), z.literal(3)]),
  deep: z
    .object({
      kind: z.literal('split'),
      model: z.string(),
      cost: z.number().nullable(),
      unpriced: z.boolean(),
      children: z.array(z.object({ title: z.string(), acceptanceCriteria: z.array(z.string()) })),
    })
    .optional(),
});

export const draftJsonSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string(),
  body: z.string(),
  score: z.number(),
  exit: z.union([z.literal(0), z.literal(1), z.literal(3)]),
  reasons: z.array(z.string()),
  model: z.string(),
  cost: z.number().nullable(),
});

export type CheckJson = z.infer<typeof checkJsonSchema>;
export type StatusJson = z.infer<typeof statusJsonSchema>;
export type LogsLineJson = z.infer<typeof logsLineJsonSchema>;
export type DaemonLoadJson = z.infer<typeof daemonLoadJsonSchema>;
export type DaemonStatusJson = z.infer<typeof daemonStatusJsonSchema>;
export type QueueListJson = z.infer<typeof queueListJsonSchema>;
export type UsageJson = z.infer<typeof usageJsonSchema>;
export type CostJson = z.infer<typeof costJsonSchema>;
export type RunsJson = z.infer<typeof runsJsonSchema>;
export type RunDiffstatJson = z.infer<typeof runDiffstatJsonSchema>;
/** One issue in `factory queue add --json` (#2275); order is null for failures or an unparsable existing order label. */
/** @remarks `detail` is set for failures; `collision` describes an order held without `factory:queued` (#2988). */
export type QueueAddIssueJson = QueueAddJson['issues'][number];
/** Queue-add payload (#2275): `ok` is false on failure; issues preserve deduped input order and labelsCreated first-seen order. Additive changes only; bump schemaVersion on a breaking change. */
export type QueueAddJson = z.infer<typeof queueAddJsonSchema>;
/** Stop/resume action result (#2276); additive changes require a schemaVersion bump if breaking. */
export type StopResumeJson = z.infer<typeof stopJsonSchema> | z.infer<typeof resumeJsonSchema>;
/** Unpark result (#2277): `collision` reports an order held without `factory:queued` (#2988). Additive changes only; bump schemaVersion on a breaking change. */
export type UnparkJson = z.infer<typeof unparkJsonSchema>;
