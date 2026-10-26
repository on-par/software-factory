// src/trace.ts — Intent-statement IDs: the traceability seam downstream artifacts cite (#471).
import { z } from 'zod';

/** `INT-<DIMENSION>-<NN>`, e.g. INT-PROBLEM-01. Ordinals widen past 99 rather than wrapping. */
export const INTENT_STATEMENT_ID_PATTERN = /^INT-[A-Z]+-\d{2,}$/;

export const IntentStatementIdSchema = z.string().regex(INTENT_STATEMENT_ID_PATTERN, 'must look like INT-PROBLEM-01');

/** Every intent statement ID a downstream artifact traces to. */
export const TracesToSchema = z.array(IntentStatementIdSchema);

export type IntentStatementId = z.infer<typeof IntentStatementIdSchema>;

/** `P<n>`: a parent issue's acceptance criterion, by 1-based checkbox position (#3105). */
export const PARENT_CRITERION_ID_PATTERN = /^P[1-9]\d*$/;

export const ParentCriterionIdSchema = z.string().regex(PARENT_CRITERION_ID_PATTERN, 'must look like P1');

export type ParentCriterionId = z.infer<typeof ParentCriterionIdSchema>;

/** What one acceptance criterion traces to: intent statements and/or parent criteria. */
export const CriterionTracesToSchema = z.array(z.union([IntentStatementIdSchema, ParentCriterionIdSchema]));

/** Structural shape of anything that cites intent — Story, Epic, or a future design artifact. */
export interface Traceable {
  readonly tracesTo?: readonly IntentStatementId[];
}

/**
 * Mint an ID. The grammar lives with the validator so minting and checking can never drift:
 * the dimension is upper-cased with non-letters stripped (`nonGoals` -> `NONGOALS`) and the
 * ordinal is 1-based, zero-padded to two digits.
 */
export function formatIntentStatementId(dimension: string, ordinal: number): IntentStatementId {
  const slug = dimension.toUpperCase().replace(/[^A-Z]/g, '');
  return `INT-${slug}-${String(Math.max(1, Math.trunc(ordinal))).padStart(2, '0')}`;
}

export function isIntentStatementId(value: unknown): value is IntentStatementId {
  return typeof value === 'string' && INTENT_STATEMENT_ID_PATTERN.test(value);
}

export function formatParentCriterionId(ordinal: number): ParentCriterionId {
  return `P${Math.max(1, Math.trunc(ordinal))}`;
}

export function isParentCriterionId(value: unknown): value is ParentCriterionId {
  return typeof value === 'string' && PARENT_CRITERION_ID_PATTERN.test(value);
}
