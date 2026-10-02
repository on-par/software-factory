// src/adr.ts — AdrDraft: a proposed architecture decision. The product proposer exports
// drafts as Proposed ADR files; the factory's PLAN/SHIP pipeline never records ADRs.
import { z } from 'zod';

export const AdrReferenceDraftSchema = z.object({
  text: z.string().min(1),
  url: z.string().min(1).optional(),
});

export const AdrDraftSchema = z.object({
  title: z.string().min(1),
  /** The mandatory 'why' — forces and constraints that drove the decision. */
  context: z.string().default(''),
  decision: z.string().default(''),
  consequences: z.string().default(''),
  /** Drafts arrive Proposed; the writer promotes them to Accepted. */
  status: z.enum(['proposed', 'accepted']).default('proposed'),
  // .nullish() (not .default()) so a bare YAML key with no items — which js-yaml parses
  // to null, not undefined — still defaults to [] rather than failing the parse. Same
  // reasoning as DesignArtifactSchema's targetTypes.
  references: z
    .array(AdrReferenceDraftSchema)
    .nullish()
    .transform((v) => v ?? []),
});

export type AdrReferenceDraft = z.infer<typeof AdrReferenceDraftSchema>;
export type AdrDraft = z.infer<typeof AdrDraftSchema>;
