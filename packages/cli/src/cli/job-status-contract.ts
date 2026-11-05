import { z } from 'zod';

import { runResultJsonSchema } from './json-contract.js';

/** `factory job` final status line (#3902): one JSON object on the last stdout line. Additive changes only; bump schemaVersion on a breaking change. */
export const jobStatusJsonSchema = runResultJsonSchema.pick({ outcome: true }).extend({
  schemaVersion: z.literal(1),
  kind: z.literal('factory-job'),
  repo: z.string(),
  issue: z.number().int(),
  merged: z.boolean(),
  exitReason: z.string().min(1),
  exitCode: z.number().int(),
  pr: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
  configSource: z.string().nullable(),
  constitutionSource: z.string().nullable(),
  timings: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    cloneMs: z.number().nullable(),
    runMs: z.number().nullable(),
    totalMs: z.number(),
  }),
});
export type JobStatusJson = z.infer<typeof jobStatusJsonSchema>;
