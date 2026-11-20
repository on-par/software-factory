import { z } from 'zod';

export const landJsonSchema = z.object({
  result: z.enum(['checks_pending', 'merged', 'checks_failed', 'conflicting', 'closed']),
  pr: z.number().int(),
  headSha: z.string().nullable(),
  pending: z.array(z.string()).optional(),
  failed: z.array(z.string()).optional(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  schemaVersion: z.literal(1),
});
export type LandJson = z.infer<typeof landJsonSchema>;
