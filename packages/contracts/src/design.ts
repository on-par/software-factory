// src/design.ts — DesignArtifact: the structured design block PLAN emits and BUILD
// consumes (originally #422; moved here in #466 so both apps share one definition).
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

export const DesignArtifactSchema = z.object({
  restatedProblem: z.string().min(1),
  approach: DesignApproachSchema,
  interfacesTouched: z.array(z.string().min(1)),
  behaviorContract: z.array(z.string().min(1)),
  verificationPlan: z.array(VerificationStepSchema),
  riskBlastRadius: z.string().min(1),
  openQuestions: z.array(z.string()),
});

export type VerificationStep = z.infer<typeof VerificationStepSchema>;
export type RejectedApproach = z.infer<typeof RejectedApproachSchema>;
export type DesignApproach = z.infer<typeof DesignApproachSchema>;
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;
