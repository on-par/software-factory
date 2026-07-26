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
});

export type VerificationStep = z.infer<typeof VerificationStepSchema>;
export type RejectedApproach = z.infer<typeof RejectedApproachSchema>;
export type DesignApproach = z.infer<typeof DesignApproachSchema>;
export type TargetType = z.infer<typeof TargetTypeSchema>;
export type Signature = z.infer<typeof SignatureSchema>;
export type CallEdge = z.infer<typeof CallEdgeSchema>;
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;
