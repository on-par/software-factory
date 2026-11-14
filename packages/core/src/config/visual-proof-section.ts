// src/config/visual-proof-section.ts — `visualProof` section of the repo config: the SHIP UI visual proof gate (#2232)

import { z } from 'zod';

const unsafePathChar = (ch: string): boolean => ch === '\\' || ch <= ' ' || ch === '\u007f';

const sameOriginPath = (path: string): boolean =>
  path.startsWith('/') && path[1] !== '/' && ![...path].some(unsafePathChar);

const VisualProofRouteSchema = z
  .object({
    route: z
      .string()
      .refine(sameOriginPath, 'route must be a path on the app: one leading /, no backslashes or whitespace')
      .describe('App path to capture, e.g. /settings'),
    state: z.string().min(1).default('default').describe('Named UI state the capture command puts the page in'),
    assert: z.string().min(1).describe('Text or selector the capture command must positively assert on the page'),
    paths: z.array(z.string().min(1)).min(1).describe('Repo-relative globs of the files this route covers'),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
      })
      .strict()
      .default({ width: 1280, height: 800 }),
  })
  .strict();

export const VisualProofModeSchema = z
  .enum(['required', 'advisory', 'off'])
  .default('required')
  .describe(
    'required: a non-pass result fails SHIP and blocks land. advisory: proof is still captured and embedded, but a non-pass result only warns. off: the gate is skipped (#4047)',
  );
export type VisualProofMode = z.infer<typeof VisualProofModeSchema>;

export const VisualProofConfigSchema = z
  .object({
    mode: VisualProofModeSchema,
    uiPaths: z.array(z.string().min(1)).min(1).describe('Globs over repo-relative paths that make up user-visible UI'),
    routes: z.array(VisualProofRouteSchema).min(1).max(10),
    command: z
      .array(z.string().min(1))
      .min(1)
      .describe('argv run once the app is ready; writes PNGs and manifest.json to $VISUAL_PROOF_OUT_DIR'),
    maxCaptures: z.number().int().min(1).max(5).default(3),
    timeoutSeconds: z.number().int().positive().default(300),
    evidenceBranch: z
      .string()
      .regex(/^[A-Za-z0-9._/-]+$/)
      .refine((name) => !name.startsWith('factory/'), 'evidenceBranch must not start with factory/')
      .default('factory-evidence')
      .describe('Branch the proof images are committed to through the Git Data API'),
  })
  .strict();
export type VisualProofConfig = z.infer<typeof VisualProofConfigSchema>;

export const VisualProofConfigSections = {
  visualProof: VisualProofConfigSchema.optional().describe('Opt-in UI visual proof gate run in SHIP (#2232).'),
};
