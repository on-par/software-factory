// src/config/host.ts — Host-level runtime policy resolved from the validated FactoryConfig:
// the host-wide BUILD/CHECK slot cap (#3043) and the cross-harness auto-failover policy.

import { defaultFactoryConfig } from '@on-par/factory-config';
import { z } from 'zod';

import type { FactoryConfig } from './index.js';

export const HostConfigSchema = z
  .object({ maxBuilds: z.number().int().positive().default(2), comment: z.string().optional() })
  .default({ maxBuilds: 2 });

/** Host-wide cap on lanes inside BUILD or CHECK at once (#3043). */
export function resolveHostMaxBuilds(config: FactoryConfig): number {
  return config.host?.maxBuilds ?? defaultFactoryConfig.host.maxBuilds;
}

export interface AutoFailoverSettings {
  enabled: boolean;
  cooldownMs: number;
  fallbackModel: string;
}

/** Failover policy comes from validated configuration, never inherited process state. */
export function resolveAutoFailover(config: FactoryConfig): AutoFailoverSettings {
  return {
    enabled: config.auto_failover?.enabled ?? defaultFactoryConfig.auto_failover.enabled,
    cooldownMs:
      (config.auto_failover?.cooldown_minutes ?? defaultFactoryConfig.auto_failover.cooldown_minutes) * 60_000,
    fallbackModel: config.auto_failover?.fallback_model ?? defaultFactoryConfig.auto_failover.fallback_model,
  };
}
