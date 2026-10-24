// Host disk guard config section and policy (#2284).
import { defaultFactoryConfig } from '@on-par/factory-config';
import { z } from 'zod';

import { DEFAULT_USAGE_POLL_MS } from '../usage/constants.js';
import type { FactoryConfig } from './index.js';

export const DiskConfigSchema = z
  .object({
    minFreeGb: z.number().nonnegative().default(10),
    comment: z.string().optional(),
  })
  .default({ minFreeGb: 10 });

/** Host disk guard policy (#2284). FACTORY_MIN_FREE_GB beats disk.minFreeGb; 0 disables. */
export interface DiskGuardPolicy {
  enabled: boolean;
  minFreeGb: number;
  retryMs: number;
}

export function resolveDiskGuard(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): DiskGuardPolicy {
  const raw = env.FACTORY_MIN_FREE_GB?.trim();
  const fromEnv = raw ? Number(raw) : Number.NaN;
  const minFreeGb =
    Number.isFinite(fromEnv) && fromEnv >= 0
      ? fromEnv
      : (config.disk?.minFreeGb ?? defaultFactoryConfig.disk.minFreeGb);
  return { enabled: minFreeGb > 0, minFreeGb, retryMs: DEFAULT_USAGE_POLL_MS };
}
