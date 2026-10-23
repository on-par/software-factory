// src/config/checks-section.ts — `checks` section of the repo config: the build/test/lint commands CHECK runs,
// declared by the repo instead of guessed from package.json, Makefile, verify.sh and friends.

import { z } from 'zod';

import { tokenizeEvidenceCommand } from '../checkers/evidence-allowlist.js';

const checkCommand = (what: string) =>
  z
    .string()
    .min(1)
    .refine((text) => tokenizeEvidenceCommand(text) !== null, {
      message: 'must be one shell-free command (no pipes, redirects, ;, &, $, backticks, globs or VAR= prefixes)',
    })
    .optional()
    .describe(`${what} command CHECK runs. Shell-free argv; beats the file-based guess.`);

export const ChecksConfigSchema = z
  .object({
    build: checkCommand('Build'),
    test: checkCommand('Test'),
    lint: checkCommand('Lint'),
  })
  .strict();
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;
export type CheckKind = keyof ChecksConfig;

export const CHECKS_DESCRIPTION =
  'CHECK commands for this repo (build, test, lint). Each beats the file-based guess; `factory init --detect-checks` writes them.';

export const ChecksConfigSections = {
  checks: ChecksConfigSchema.optional().describe(CHECKS_DESCRIPTION),
};

/** argv for a declared check command. The schema already rejected untokenizable text, so null means unset. */
export function checkCommandArgv(checks: ChecksConfig | null | undefined, kind: CheckKind): string[] | null {
  const text = checks?.[kind];
  if (text === undefined) return null;
  const argv = tokenizeEvidenceCommand(text);
  return argv ? [...argv] : null;
}
