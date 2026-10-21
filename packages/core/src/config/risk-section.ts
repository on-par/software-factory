// src/config/risk-section.ts — `risk` section of the repo config: the repo risk policy (#3387)
//
// The shape mirrors RiskRuleSet in packages/config/src/risk.ts. Zod checks the structure (and
// documents it in the JSON Schema and docs/config.example.yaml); parseRiskRules then runs the
// rest (unique ids, compiling patterns, a matcher per rule), so the two cannot disagree.

import { parseRiskRules, type RiskRulesError } from '@on-par/factory-config';
import { z } from 'zod';

const RiskRuleSchema = z
  .object({
    id: z.string().describe('Rule id, /^[a-z0-9][a-z0-9-]*$/, unique in the policy.'),
    tier: z.enum(['low', 'med', 'high']).describe('Tier a matching path gets. The highest tier across rules wins.'),
    description: z.string().optional(),
    globs: z
      .array(z.string())
      .optional()
      .describe("Globs over the whole repo-relative path; '**' crosses '/', '*' and '?' do not; case-insensitive."),
    patterns: z.array(z.string()).optional().describe("Regex sources tested against the whole path with the 'i' flag."),
  })
  .strict();

export const RiskSectionSchema = z
  .object({
    rules: z
      .array(RiskRuleSchema)
      .describe('Risk rules. They replace the packaged rules; a path that matches no rule is `med`.'),
    refactorAllowlist: z
      .array(z.string())
      .optional()
      .describe("Globs for allowlisted pure-refactor paths; they fire the low 'allowlisted-refactor' rule."),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      parseRiskRules(value);
    } catch (err) {
      // parseRiskRules throws only RiskRulesError.
      const { message, index } = err as RiskRulesError;
      ctx.addIssue({ code: 'custom', message, path: index === undefined ? [] : ['rules', index] });
    }
  })
  .optional()
  .describe(
    'Repo risk policy for the risk receipt and the land risk gate (schema: packages/config/src/risk.ts). ' +
      'Unset: the packaged default rules.',
  );

/** Repo-config key for the risk policy, spread into the V2 schema (the legacy V1 shape does not take it). */
export const RiskConfigSections = { risk: RiskSectionSchema };
