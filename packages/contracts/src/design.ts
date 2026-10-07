// src/design.ts — DesignArtifact: the structured design block PLAN emits and BUILD
// consumes (originally #422; moved here in #466 so both apps share one definition;
// deepened in #480).
import { z } from 'zod';

export const VerificationStepSchema = z.object({
  command: z.string().min(1),
  passWhen: z.string().min(1),
});

export const RejectedApproachSchema = z.object({
  option: z.string().min(1),
  reason: z.string().min(1),
});

export const DesignApproachSchema = z.object({
  chosen: z.string().min(1),
  rejected: z.array(RejectedApproachSchema),
});

export const TargetTypeSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  kind: z.enum(['added', 'changed', 'read']).default('changed'),
});

export const SignatureSchema = z.object({
  symbol: z.string().min(1),
  file: z.string().min(1),
  signature: z.string().min(1),
});

export const CallEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  note: z.string().min(1).optional(),
});

export const BehaviorVerdictSchema = z.enum(['same', 'better', 'worse', 'unknown']);

export const BehaviorDeltaRowSchema = z.object({
  input: z.string().min(1),
  branch: z.string().min(1),
  before: z.string().min(1),
  after: z.string().min(1),
  verdict: BehaviorVerdictSchema,
});

// js-yaml reads an unquoted list item containing ': ' as a one-key map (#2216, #551).
// Turn it back into the line the model wrote; any other non-string becomes its JSON text,
// so one bad item never discards the whole artifact.
export function coerceListItem(item: unknown): unknown {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const entries = Object.entries(item);
    if (entries.length === 1) {
      const [key, value] = entries[0]!;
      if (value === null || value === undefined) return `${key}:`;
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}: ${text}`;
    }
  }
  return JSON.stringify(item) ?? String(item);
}

const stringListItem = z.preprocess(coerceListItem, z.string().min(1));

export const ExternalListSchema = z.object({
  name: z.string().min(1),
  location: z.string().min(1),
  source: z.string().min(1),
  gaps: z.array(stringListItem),
});

// Evidence per claim (#2257). Each kind requires its own field: fail-to-pass-test needs
// `test`, command needs `command` + `passWhen`, screenshot needs `route`, none needs `reason`.
export const EvidenceKindSchema = z.enum(['fail-to-pass-test', 'command', 'screenshot', 'none']);

export const FailToPassTestEvidenceSchema = z.object({
  kind: z.literal('fail-to-pass-test'),
  claim: z.string().min(1),
  test: z.string().min(1),
});

export const CommandEvidenceSchema = z.object({
  kind: z.literal('command'),
  claim: z.string().min(1),
  command: z.string().min(1),
  passWhen: z.string().min(1),
});

export const ScreenshotEvidenceSchema = z.object({
  kind: z.literal('screenshot'),
  claim: z.string().min(1),
  route: z.string().min(1),
});

export const NoEvidenceSchema = z.object({
  kind: z.literal('none'),
  claim: z.string().min(1),
  reason: z.string().min(1),
});

export const EvidencePlanEntrySchema = z.discriminatedUnion('kind', [
  FailToPassTestEvidenceSchema,
  CommandEvidenceSchema,
  ScreenshotEvidenceSchema,
  NoEvidenceSchema,
]);

// A bare YAML key parses to null, which must not fail the whole parse; and unlike
// targetTypes the key stays optional in the inferred type (no [] default injected).
const optionalList = <T extends z.ZodType>(item: T) => z.preprocess((v) => v ?? undefined, z.array(item).optional());

export const DesignArtifactSchema = z.object({
  restatedProblem: z.string().min(1),
  approach: DesignApproachSchema,
  interfacesTouched: z.array(stringListItem),
  // .nullish() (not .default()) so a bare YAML key with no items — which js-yaml
  // parses to null, not undefined — still defaults to [] instead of failing the
  // whole DesignArtifactSchema parse.
  targetTypes: z
    .array(TargetTypeSchema)
    .nullish()
    .transform((v) => v ?? []),
  signatures: z
    .array(SignatureSchema)
    .nullish()
    .transform((v) => v ?? []),
  callGraph: z
    .array(CallEdgeSchema)
    .nullish()
    .transform((v) => v ?? []),
  behaviorContract: z.array(stringListItem),
  verificationPlan: z.array(VerificationStepSchema),
  riskBlastRadius: z.string().min(1),
  openQuestions: z.array(z.preprocess(coerceListItem, z.string())),
  edgeInputs: optionalList(stringListItem),
  behaviorDelta: optionalList(BehaviorDeltaRowSchema),
  externalLists: optionalList(ExternalListSchema),
  evidencePlan: optionalList(EvidencePlanEntrySchema),
});

export type VerificationStep = z.infer<typeof VerificationStepSchema>;
export type RejectedApproach = z.infer<typeof RejectedApproachSchema>;
export type DesignApproach = z.infer<typeof DesignApproachSchema>;
export type TargetType = z.infer<typeof TargetTypeSchema>;
export type Signature = z.infer<typeof SignatureSchema>;
export type CallEdge = z.infer<typeof CallEdgeSchema>;
export type BehaviorVerdict = z.infer<typeof BehaviorVerdictSchema>;
export type BehaviorDeltaRow = z.infer<typeof BehaviorDeltaRowSchema>;
export type ExternalList = z.infer<typeof ExternalListSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type FailToPassTestEvidence = z.infer<typeof FailToPassTestEvidenceSchema>;
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;
export type ScreenshotEvidence = z.infer<typeof ScreenshotEvidenceSchema>;
export type NoEvidence = z.infer<typeof NoEvidenceSchema>;
export type EvidencePlanEntry = z.infer<typeof EvidencePlanEntrySchema>;
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;

const STRING_LIST_FIELDS = ['interfacesTouched', 'behaviorContract', 'openQuestions', 'edgeInputs'] as const;

/** Paths (e.g. 'edgeInputs[11]', 'externalLists[0].gaps[2]') of the raw design's
 *  string-list items that coerceListItem will rewrite. Non-object input or non-array
 *  fields yield nothing. */
export function findCoercedDesignItems(design: unknown): string[] {
  if (typeof design !== 'object' || design === null) return [];
  const d = design as Record<string, unknown>;
  const paths: string[] = [];
  const walk = (list: unknown, prefix: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, i) => {
      if (typeof item !== 'string') paths.push(`${prefix}[${i}]`);
    });
  };
  for (const field of STRING_LIST_FIELDS) walk(d[field], field);
  if (Array.isArray(d.externalLists)) {
    d.externalLists.forEach((row, i) => {
      if (typeof row === 'object' && row !== null) {
        walk((row as Record<string, unknown>).gaps, `externalLists[${i}].gaps`);
      }
    });
  }
  return paths;
}
