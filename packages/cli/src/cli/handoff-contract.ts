import { z } from 'zod';

export const handoffJsonSchema = z.object({
  version: z.literal(1),
  stopReason: z.enum(['deadline', 'sigterm']),
  phase: z.enum(['plan', 'build', 'check', 'ship']),
  baseSha: z.string().nullable(),
  wipBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  specPath: z.string().nullable(),
  criteria: z.array(
    z.object({
      criterion: z.string(),
      status: z.enum(['done', 'failing', 'not_started']),
      proof: z.string().nullable(),
    }),
  ),
  lastFailure: z.string().nullable(),
  nextStep: z.string(),
  fitsOneRun: z.boolean(),
});
