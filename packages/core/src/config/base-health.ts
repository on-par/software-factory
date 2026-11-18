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

export const CheckConfigSchema = z
  .object({
    hermeticGit: z
      .boolean()
      .optional()
      .describe(
        'Run CHECK commands with an empty global and system git config (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1), as on a CI runner. Set false when checks need host git settings such as a credential helper. Unset: true.',
      ),
    baselineCacheTtlHours: z
      .number()
      .positive()
      .optional()
      .describe(
        'Hours a cached baseline (base SHA) checker result is reused before CHECK and base health re-run it (#3540). Unset: 24.',
      ),
    timeBudget: z
      .object({
        verifyMinutes: z
          .number()
          .positive()
          .optional()
          .describe('Expected minutes for one verify pass before this run has measured one. Unset: 10.'),
        reworkBuildMinutes: z
          .number()
          .positive()
          .optional()
          .describe('Minutes allowed for one rework build, added to one verify for a rework round. Unset: 10.'),
        safetyMarginMinutes: z
          .number()
          .nonnegative()
          .optional()
          .describe('Minutes kept in reserve before the run deadline. Unset: 2.'),
      })
      .strict()
      .optional()
      .describe(
        'Estimates CHECK uses when FACTORY_RUN_DEADLINE_AT sets a run deadline (#4264): a flake re-run or rework round that would not finish before the deadline is skipped and the issue parks time-budget. No effect without a deadline.',
      ),
  })
  .strict()
  .optional()
  .describe('CHECK phase settings (#3272, #3540, #4264).');

export const DEFAULT_BASELINE_CACHE_TTL_HOURS = 24;

/** Hours a cached baseline checker result is reused (#3540); 24 unless the repo sets check.baselineCacheTtlHours. */
export function resolveBaselineCacheTtlHours(repo: { check?: { baselineCacheTtlHours?: number } } | null): number {
  return repo?.check?.baselineCacheTtlHours ?? DEFAULT_BASELINE_CACHE_TTL_HOURS;
}

export function resolveCheckTimeBudget(
  repo: {
    check?: { timeBudget?: { verifyMinutes?: number; reworkBuildMinutes?: number; safetyMarginMinutes?: number } };
  } | null,
): { verifyMinutes?: number; reworkBuildMinutes?: number; safetyMarginMinutes?: number } {
  return { ...repo?.check?.timeBudget };
}

/** Repo-config keys for base health and CHECK settings, spread into the V2 schema. */
export const HealthConfigSections = { baseHealth: BaseHealthConfigSchema, check: CheckConfigSchema };

/** Whether CHECK runs checker commands with an empty global and system git config (#3272); on unless the repo opts out. */
export function resolveHermeticGit(repo: { check?: { hermeticGit?: boolean } } | null): boolean {
  return repo?.check?.hermeticGit ?? true;
}

/** Code-health check names for the base verdict (#3290): repo `baseHealth.checks` when non-empty, else undefined (required checks, then the CI workflow). */
export function resolveBaseHealthChecks(repo: { baseHealth?: { checks?: string[] } } | null): string[] | undefined {
  const checks = [...new Set((repo?.baseHealth?.checks ?? []).map((c) => c.trim()).filter((c) => c !== ''))];
  return checks.length > 0 ? checks : undefined;
}
