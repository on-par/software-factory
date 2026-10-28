// Optional PR presentation settings shared by the repo and unified schemas.
import { defaultFactoryConfig, defaultPrWalkthrough } from '@on-par/factory-config';
import { z } from 'zod';

export const PrConfigSections = {
  pr: z
    .object({
      footer: z
        .string()
        .optional()
        .describe(
          `Last line of the PR body. Unset: "${defaultFactoryConfig.pr.footer}". A non-empty string replaces it verbatim; "" removes the footer and its separator. Plain string only, with no templating or token substitution.`,
        ),
      walkthrough: z
        .object({
          minLines: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              `Minimum changed lines (additions plus deletions) vs main. Unset: ${defaultPrWalkthrough.minLines}.`,
            ),
          minFiles: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(`Minimum changed files vs main. Unset: ${defaultPrWalkthrough.minFiles}.`),
        })
        .strict()
        .optional()
        .describe(
          'Large-PR walkthrough (#3623). SHIP adds a walkthrough (intent, main files, how to verify) to the PR body and evidence pack when the diff vs main has at least minLines changed lines AND at least minFiles files. Soft artifact: a failure to build it is logged and never blocks the PR.',
        ),
      evidenceComment: z
        .boolean()
        .optional()
        .describe(
          'Post the evidence pack (checks, rework, timeline, artifacts) as a comment on the PR SHIP opens. Unset: off. The PR body is unchanged either way.',
        ),
    })
    .strict()
    .optional()
    .describe('PR body presentation.'),
};
