// packages/core/src/config/run-section.ts — the FactoryConfig `run` section and the
// draft-PR policy it carries (#3449).

import { z } from 'zod';

/** `run.merge.*` mirrors FactoryConfigV2Schema's `run.merge`; `run.pr.draft` stops SHIP at a
 *  draft PR. Everything is optional with no defaults so "unset" survives parsing. */
export const RunConfigSectionSchema = z
  .object({
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
