// packages/core/src/config/run-section.ts — the FactoryConfig `run` section and the
// draft-PR policy it carries (#3449).

import { z } from 'zod';

import { branchPrefixSlug, slugify } from '../utils/branch-slug.js';

/** `run.merge.*` mirrors FactoryConfigV2Schema's `run.merge`; `run.pr.draft` stops SHIP at a
 *  draft PR; `run.branchPrefix` is the repo's default branch-name prefix. Everything is
 *  optional with no defaults so "unset" survives parsing. */
export const RunConfigSectionSchema = z
  .object({
    branchPrefix: z
      .string()
      .refine((v) => slugify(v) !== '', 'must contain at least one letter or digit')
      .optional(),
    merge: z
      .object({
        auto: z.boolean().optional(),
        admin: z.boolean().optional(),
        classifier: z.boolean().optional(),
      })
      .strict()
      .optional(),
    pr: z.object({ draft: z.boolean().optional() }).strict().optional(),
  })
  .strict()
  .optional();

export type BranchPrefixConfig = { run?: { branchPrefix?: string } };

/** Branch-name prefix shared by ship, land, and ingest so they agree on which
 *  factory branches/worktrees belong to this run: run.branchPrefix (slugged) > 'factory'.
 *  `--branch-prefix` beats both (resolveBranchPrefixOption). FACTORY_BRANCH_PREFIX is not read. */
export function resolveBranchPrefix(config?: BranchPrefixConfig): string {
  const configured = config?.run?.branchPrefix;
  return configured === undefined ? 'factory' : branchPrefixSlug(configured);
}

export interface EffectiveDraftPrPolicy {
  draft: boolean;
  source: 'flag' | 'repo' | 'default';
}

/** flag (--draft-pr / --no-draft-pr) > run.pr.draft > default off. */
export function resolveDraftPrPolicy(
  config: { run?: { pr?: { draft?: boolean } } },
  flag?: boolean,
): EffectiveDraftPrPolicy {
  if (flag !== undefined) return { draft: flag, source: 'flag' };
  const repo = config.run?.pr?.draft;
  if (repo !== undefined) return { draft: repo, source: 'repo' };
  return { draft: false, source: 'default' };
}

export function describeDraftPrPolicy(policy: EffectiveDraftPrPolicy, repoConfigPath: string): string {
  const source =
    policy.source === 'flag'
      ? `flag: ${policy.draft ? '--draft-pr' : '--no-draft-pr'}`
      : policy.source === 'repo'
        ? repoConfigPath
        : 'default';
  return `Draft PR: ${policy.draft ? 'on' : 'off'} (${source})`;
}
