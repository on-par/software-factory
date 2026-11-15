import { z } from 'zod';

import type { GitHubCredentialsSettings } from '../github-scope/broker.js';

const positiveId = z.number().int().positive();

export const GitHubCredentialsConfigSchema = z
  .object({
    allowAmbientToken: z.boolean().default(false),
    app: z.object({ appId: positiveId, installationId: positiveId }).strict().optional(),
    comment: z.string().optional(),
  })
  .strict();

export const GitHubConfigSchema = z
  .object({
    credentials: GitHubCredentialsConfigSchema.default({ allowAmbientToken: false }),
    comment: z.string().optional(),
  })
  .strict()
  .default({ credentials: { allowAmbientToken: false } });

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

export function resolveGitHubCredentialsConfig(config: { github?: GitHubConfig }): GitHubCredentialsSettings {
  const credentials = config.github?.credentials;
  return {
    allowAmbientToken: credentials?.allowAmbientToken ?? false,
    ...(credentials?.app ? { app: credentials.app } : {}),
  };
}
