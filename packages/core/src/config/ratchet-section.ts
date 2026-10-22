// packages/core/src/config/ratchet-section.ts — the FactoryConfig `ratchet` section (#3542).

import { z } from 'zod';

/** `ratchet.lists`: exception lists the daily ratchet takes one entry off; `lane` is where the issue is queued. */
export const RatchetConfigSchema = z
  .object({
    lists: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
          file: z.string().min(1),
          check: z.string().min(1),
        }),
      )
      .default([]),
    lane: z.string().default('auto'),
    comment: z.string().optional(),
  })
  .default({ lists: [], lane: 'auto' });
