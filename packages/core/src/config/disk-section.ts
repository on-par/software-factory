// src/config/disk-section.ts — the `disk` section of FactoryConfig (#2284)

import { z } from 'zod';

export const DiskConfigSchema = z
  .object({
    minFreeGb: z.number().nonnegative().default(10),
    comment: z.string().optional(),
  })
  .default({ minFreeGb: 10 });
