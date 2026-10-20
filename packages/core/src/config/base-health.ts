// src/config/base-health.ts — `baseHealth` section of the repo config: which checks decide whether main is green (#3290)

import { z } from 'zod';

export const BaseHealthConfigSchema = z
  .object({
    checks: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Check-run names that decide whether main is green for the base-hold gate and base health. Unset: the branch-protection required checks, else the check runs of the push workflow named CI. Other failed push workflows (Release, deploy) log base_push_workflow_failed and never hold.',
      ),
  })
  .strict()
  .optional()
  .describe('Which checks decide base health (#3290).');

/** Code-health check names for the base verdict (#3290): repo `baseHealth.checks` when non-empty, else undefined (required checks, then the CI workflow). */
export function resolveBaseHealthChecks(repo: { baseHealth?: { checks?: string[] } } | null): string[] | undefined {
  const checks = [...new Set((repo?.baseHealth?.checks ?? []).map((c) => c.trim()).filter((c) => c !== ''))];
  return checks.length > 0 ? checks : undefined;
}
