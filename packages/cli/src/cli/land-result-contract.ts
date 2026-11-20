import { z } from 'zod';

const landResultBase = {
  schemaVersion: z.literal(1),
  pr: z.number().int(),
  headSha: z.string().nullable(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
};
export const landResultJsonSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('checks_failed'), ...landResultBase, failed: z.array(z.string()) }),
  z.object({
    result: z.enum(['merged', 'checks_pending', 'conflicting', 'closed']),
    ...landResultBase,
    pending: z.array(z.string()),
  }),
]);
export type LandResultJson = z.infer<typeof landResultJsonSchema>;
