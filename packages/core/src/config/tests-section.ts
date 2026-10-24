// src/config/tests-section.ts — `tests` section of the repo config: opt-in affected-test selection for CHECK rework rounds (#3260)

import { z } from 'zod';

import { tokenizeEvidenceCommand } from '../checkers/evidence-allowlist.js';

export const TestsAffectedConfigSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .refine((text) => tokenizeEvidenceCommand(text) !== null, {
        message: 'must be one shell-free command (no pipes, redirects, ;, &, $, backticks, globs or VAR= prefixes)',
      })
      .refine((text) => tokenizeEvidenceCommand(text)?.includes('{files}') === true, {
        message: 'must contain {files} as its own argument',
      })
      .describe(
        'Affected-tests command for CHECK rework rounds; {files} expands to the changed paths, each shell-quoted. e.g. "npx vitest related --run {files}"',
      ),
    fullOn: z
      .array(z.string().min(1))
      .optional()
      .describe('Extra globs that force the full suite; added to the built-in triggers, never replacing them.'),
  })
  .strict();
export type TestsAffectedConfig = z.infer<typeof TestsAffectedConfigSchema>;

export const TestsConfigSchema = z.object({ affected: TestsAffectedConfigSchema.optional() }).strict();

export const TestsConfigSections = {
  tests: TestsConfigSchema.optional().describe(
    'Test selection for CHECK rework rounds. Unset: every round runs the full suite.',
  ),
};
