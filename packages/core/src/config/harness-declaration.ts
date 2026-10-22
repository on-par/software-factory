// src/config/harness-declaration.ts — harness declaration schema, a leaf module so v2.ts can use it without a config/index.ts cycle.

import { z } from 'zod';

import type { HarnessFailureReason } from '../harness/index.js';

export const HARNESS_PROMPT_MODES = ['stdin', 'file', 'arg'] as const;
export const HARNESS_OUTPUT_MODES = ['stdout', 'file:{outFile}', 'jsonl-last-message'] as const;
export const HARNESS_USAGE_MODES = ['none', 'jsonl'] as const;

/** Failure reasons an `errorPatterns` record key may select (mirrors FailoverReason). */
export const HARNESS_ERROR_PATTERN_REASONS = [
  'rate_limit',
  'usage_cap',
  'timeout',
  'error',
  'empty_response',
  'unavailable',
  'local_auth',
  'cli_missing',
  'schema_invalid',
  'apply_failed',
  'verify_failed',
  'permission_denied',
  'unknown',
] as const satisfies readonly HarnessFailureReason[];

function isValidRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** An errorPatterns regex may include a named `(?<reset>…)` group; when its capture parses as a date it becomes the
 *  failure's `resetAt`, so the breaker holds the provider until then. */
const RegexString = z.string().refine(isValidRegExp, 'errorPatterns entries must be valid regular expressions');

export const HarnessDeclarationSchema = z
  .object({
    command: z.string({ error: 'command is required (the CLI to run)' }).min(1, 'command must not be empty'),
    prompt: z.enum(HARNESS_PROMPT_MODES, {
      error: `prompt must be one of: ${HARNESS_PROMPT_MODES.join(', ')}`,
    }),
    output: z.enum(HARNESS_OUTPUT_MODES, {
      error: `output must be one of: ${HARNESS_OUTPUT_MODES.join(', ')}`,
    }),
    agentic: z.boolean({ error: 'agentic must be true or false' }),
    usage: z.enum(HARNESS_USAGE_MODES, {
      error: `usage must be one of: ${HARNESS_USAGE_MODES.join(', ')}`,
    }),
    errorPatterns: z
      .union([z.partialRecord(z.enum(HARNESS_ERROR_PATTERN_REASONS), RegexString), z.array(RegexString)], {
        error: `errorPatterns must map a failure reason (${HARNESS_ERROR_PATTERN_REASONS.join(', ')}) to a regex, or be a list of regexes`,
      })
      .optional(),
    probe: z.string().min(1, 'probe must not be empty').optional(),
  })
  .strict();

export type HarnessDeclaration = z.infer<typeof HarnessDeclarationSchema>;
