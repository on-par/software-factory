// src/config/visual-proof-section.ts — `visualProof` section of the repo config: the SHIP UI visual proof gate (#2232)

import { z } from 'zod';

const unsafePathChar = (ch: string): boolean => ch === '\\' || ch <= ' ' || ch === '\u007f';

const sameOriginPath = (path: string): boolean =>
  path.startsWith('/') && path[1] !== '/' && !Array.from(path).some(unsafePathChar);

const selectorOrText = z.string().min(1);

export const VisualProofStepSchema = z.union([
  z
    .object({ goto: z.string().refine(sameOriginPath, 'goto must be a path on the app') })
    .strict()
    .describe('Navigate to a same-origin app path'),
  z
    .object({ click: selectorOrText })
    .strict()
    .describe('Click the element matching the selector (same syntax as assert)'),
  z
    .object({ fill: selectorOrText, value: z.string() })
    .strict()
    .describe('Fill the input matching the selector with value (may be empty)'),
  z
    .object({ press: z.string().min(1) })
    .strict()
    .describe('Press a key such as Enter or Escape'),
  z
    .object({ waitFor: selectorOrText })
    .strict()
    .describe('Wait for a selector or text to appear (same syntax as assert)'),
]);
export type VisualProofStep = z.infer<typeof VisualProofStepSchema>;

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
    steps: z
      .array(VisualProofStepSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Ordered steps the capture command applies after loading the route to reach `state`; `before` is captured on load, `after` once the steps ran and `assert` passed',
      ),
    record: z.enum(['gif', 'video']).optional().describe('Also record a short size-capped clip of the steps'),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.record && !route.steps) ctx.addIssue({ code: 'custom', path: ['record'], message: 'record needs steps' });
  });

export const VisualProofModeSchema = z
  .enum(['required', 'advisory', 'off'])
  .default('required')
  .describe(
    'required: a non-pass result fails SHIP and blocks land. advisory: proof is still captured and embedded, but a non-pass result only warns. off: the gate is skipped (#4047)',
  );
export type VisualProofMode = z.infer<typeof VisualProofModeSchema>;

const EVIDENCE_BRANCH_REMOVED =
  'visualProof.evidenceBranch was removed: visual proof now uploads as PR attachments with gh pr edit --attach; delete the key';

export const VisualProofConfigSchema = z.strictObject(
  {
    mode: VisualProofModeSchema,
    uiPaths: z.array(z.string().min(1)).min(1).describe('Globs over repo-relative paths that make up user-visible UI'),
    routes: z.array(VisualProofRouteSchema).min(1).max(10),
    command: z
      .array(z.string().min(1))
      .min(1)
      .describe('argv run once the app is ready; writes PNGs and manifest.json to $VISUAL_PROOF_OUT_DIR'),
    maxCaptures: z.number().int().min(1).max(5).default(3),
    timeoutSeconds: z.number().int().positive().default(300),
    captureAttempts: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe('Attempts per SHIP before a capture failure is final; each failed attempt is logged with its reason'),
  },
  {
    error: (iss) =>
      iss.code === 'unrecognized_keys' && iss.keys.includes('evidenceBranch') ? EVIDENCE_BRANCH_REMOVED : undefined,
  },
);
export type VisualProofConfig = z.infer<typeof VisualProofConfigSchema>;

export const VisualProofConfigSections = {
  visualProof: VisualProofConfigSchema.optional().describe('Opt-in UI visual proof gate run in SHIP (#2232).'),
};
