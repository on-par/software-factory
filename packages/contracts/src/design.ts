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

export const ExternalListSchema = z.object({
  name: z.string().min(1),
  location: z.string().min(1),
  source: z.string().min(1),
  gaps: z.array(z.string().min(1)),
});

// A bare YAML key parses to null, which must not fail the whole parse; and unlike
// targetTypes the key stays optional in the inferred type (no [] default injected).
const optionalList = <T extends z.ZodType>(item: T) => z.preprocess((v) => v ?? undefined, z.array(item).optional());

export const DesignArtifactSchema = z.object({
  restatedProblem: z.string().min(1),
  approach: DesignApproachSchema,
  interfacesTouched: z.array(z.string().min(1)),
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
  behaviorContract: z.array(z.string().min(1)),
  verificationPlan: z.array(VerificationStepSchema),
  riskBlastRadius: z.string().min(1),
  openQuestions: z.array(z.string()),
  edgeInputs: optionalList(z.string().min(1)),
  behaviorDelta: optionalList(BehaviorDeltaRowSchema),
  externalLists: optionalList(ExternalListSchema),
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
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;
