import { z } from 'zod';

export const LandConfigSections = {
  land: z
    .object({
      waitForCi: z
        .boolean()
        .optional()
        .describe(
          'false: factory land reads the PR and its checks once, merges a green and mergeable head, and otherwise returns checks_pending (exit 75) without waiting. Unset or true: wait for CI. --no-wait beats it.',
        ),
    })
    .strict()
    .optional()
    .describe('factory land behaviour.'),
};
