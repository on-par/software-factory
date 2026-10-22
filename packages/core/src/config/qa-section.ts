// src/config/qa-section.ts — `qa` section of the repo config: commands for the opt-in app_smoke checker (#3253)

import { z } from 'zod';

export const QaConfigSchema = z
  .object({
    start: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('argv that starts the built app; must listen on $PORT'),
    smoke: z.array(z.string().min(1)).min(1).optional().describe('argv run once the app is ready; exit 0 passes'),
    readyPath: z.string().startsWith('/').default('/').describe('Path polled until it answers below 500'),
    readyTimeoutSeconds: z.number().int().positive().default(60),
  })
  .strict();
export type QaConfig = z.infer<typeof QaConfigSchema>;

export const QaConfigSections = {
  qa: QaConfigSchema.optional().describe('App smoke commands for the opt-in app_smoke checker.'),
};
