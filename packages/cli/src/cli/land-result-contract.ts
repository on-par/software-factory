import { z } from 'zod';

const landResultBase = {
  schemaVersion: z.literal(1),
  pr: z.number().int(),
  headSha: z.string().nullable(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
};

export const landResultJsonSchema = z.discriminatedUnion('result', [
  z.object({ ...landResultBase, result: z.literal('checks_pending'), pending: z.array(z.string()) }),
  z.object({ ...landResultBase, result: z.literal('checks_failed'), failed: z.array(z.string()) }),
  z.object({ ...landResultBase, result: z.enum(['merged', 'conflicting', 'closed']) }),
]);
export type LandResultJson = z.infer<typeof landResultJsonSchema>;
