// Optional PR presentation settings shared by the repo and unified schemas.
import { defaultFactoryConfig } from '@on-par/factory-config';
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
    })
    .strict()
    .optional()
    .describe('PR body presentation.'),
};
