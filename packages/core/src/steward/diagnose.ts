// src/steward/diagnose.ts — steward verdict schema with confidence-based escalation (#2110, ADR-0144)
import { z } from 'zod';
import type { StewardPacket } from './packet.js';

/** Confidence below this value escalates the verdict. Fixed by ADR-0144; not a config value. */
export const STEWARD_ESCALATION_THRESHOLD = 0.9;

/** Closed set of diagnosis categories. */
export const STEWARD_VERDICT_CATEGORIES = ['spec', 'test', 'code', 'flaky', 'environment', 'unknown'] as const;

/** Packet item keys a citation may point at. Kept in sync with the StewardPacket interface. */
export const STEWARD_PACKET_FIELDS = [
  'issue',
  'plan',
  'diff',
  'logs',
  'adrs',
] as const satisfies readonly (keyof StewardPacket)[];

/** Output caps from ADR-0144's output table. */
export const STEWARD_VERDICT_CAPS = {
  diagnosis: 2000,
  nextStep: 1000,
  citations: 10,
  excerpt: 500,
} as const;

/** One piece of evidence: the packet item it came from and an excerpt. */
export const StewardCitationSchema = z
  .object({
    field: z.enum(STEWARD_PACKET_FIELDS),
    excerpt: z.string().min(1).max(STEWARD_VERDICT_CAPS.excerpt),
  })
  .strict();

/** Strict schema for the model's steward verdict. */
export const StewardVerdictSchema = z
  .object({
    diagnosis: z.string().trim().min(1).max(STEWARD_VERDICT_CAPS.diagnosis),
    category: z.enum(STEWARD_VERDICT_CATEGORIES),
    // No .trim(): nextStep is preserved exactly. Whitespace-only text is rejected by the refine.
    nextStep: z
      .string()
      .min(1)
      .max(STEWARD_VERDICT_CAPS.nextStep)
      .refine((s) => s.trim().length > 0),
    confidence: z.number().min(0).max(1),
    citations: z.array(StewardCitationSchema).min(1).max(STEWARD_VERDICT_CAPS.citations),
  })
  .strict();

export type StewardVerdict = z.infer<typeof StewardVerdictSchema>;
export type EscalatedStewardVerdict = StewardVerdict & { escalate: boolean };

/** Pure: returns the verdict plus `escalate`, true when confidence is below the threshold. */
export function applyEscalation(verdict: StewardVerdict): EscalatedStewardVerdict {
  return { ...verdict, escalate: verdict.confidence < STEWARD_ESCALATION_THRESHOLD };
}

/** Validates unknown model output and applies escalation. Throws a ZodError on invalid input. */
export function parseStewardVerdict(raw: unknown): EscalatedStewardVerdict {
  return applyEscalation(StewardVerdictSchema.parse(raw));
}
