import { z } from 'zod';

export const DEFAULT_HTML_IGNORE: readonly string[] = [];

const CheckersConfigSchema = z
  .object({
    html: z
      .object({
        ignore: z
          .array(z.string().min(1))
          .default(() => [...DEFAULT_HTML_IGNORE])
          .describe(
            'Path prefixes or globs, relative to the repo root, whose HTML files the links and accessibility checkers skip. Replaces the default. Unset: ["docs/**"]; [] scans every HTML file.',
          ),
      })
      .strict()
      .optional()
      .describe('HTML discovery for the links and accessibility checkers.'),
  })
  .strict();
export type CheckersConfig = z.infer<typeof CheckersConfigSchema>;

export const CheckersConfigSections = {
  checkers: CheckersConfigSchema.optional().describe('Settings for the built-in links and accessibility checkers.'),
};

export function resolveHtmlIgnore(checkers: CheckersConfig | null | undefined): readonly string[] {
  return checkers?.html?.ignore ?? DEFAULT_HTML_IGNORE;
}
