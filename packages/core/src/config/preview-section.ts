import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

const insideWorktree = (path: string): boolean => {
  const normalized = normalize(path);
  return !isAbsolute(path) && normalized !== '..' && !normalized.startsWith('../');
};

const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

const PreviewSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('deployment'),
      environment: z.string().min(1).describe('Deployment environment glob (`*` matches any run), e.g. preview/pr-*'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('comment'),
      urlPattern: z
        .string()
        .min(1)
        .refine(compiles, 'urlPattern must be a valid regular expression')
        .describe('Regex over PR comments; the URL is the named group `url`, else group 1'),
      authors: z
        .array(z.string().min(1))
        .default([])
        .describe('Comment author logins trusted to post the preview URL, e.g. vercel[bot]'),
      authorAssociations: z
        .array(z.enum(TRUSTED_ASSOCIATIONS))
        .default([])
        .describe('Author association levels trusted to post the preview URL'),
    })
    .strict()
    .refine(
      (source) => source.authors.length + source.authorAssociations.length > 0,
      'a comment source needs authors or authorAssociations',
    ),
]);

export const PreviewConfigSchema = z
  .object({
    source: PreviewSourceSchema,
    readyPath: z.string().startsWith('/').default('/').describe('Path polled until the preview answers expectedStatus'),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    readyTimeoutSeconds: z.number().int().positive().default(300),
    command: z.array(z.string().min(1)).min(1).describe('argv run against the preview; exit 0 passes'),
    urlEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('PREVIEW_URL')
      .describe('Env var that carries the preview URL to the command'),
    commandTimeoutSeconds: z.number().int().positive().default(600),
    artifacts: z
      .array(z.string().min(1).refine(insideWorktree, 'artifact paths must stay inside the worktree'))
      .default([])
      .describe('Worktree-relative report paths attached when present'),
  })
  .strict();
export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;

export const PreviewConfigSections = {
  preview: PreviewConfigSchema.optional().describe(
    'Opt-in preview-environment gate run in SHIP after CI is green (#3880).',
  ),
};
