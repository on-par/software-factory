// packages/product/src/intent/intent-doc.ts — the Intent Doc + human gate #1 (#471).

import type { IntentStatementId } from '@on-par/contracts';
import { formatIntentStatementId } from '@on-par/contracts';

import type { IntentDimension, InterviewResult } from '../interview/index.js';
import { extractStatements } from './statements.js';

export type IntentDocStatus = 'draft' | 'approved';

export interface IntentStatement {
  /** Stable, doc-unique ID minted by @on-par/contracts — e.g. INT-PROBLEM-01. */
  id: IntentStatementId;
  dimension: IntentDimension;
  text: string;
  source: 'answer' | 'brain-dump';
}

export interface IntentDoc {
  brainDump: string;
  statements: readonly IntentStatement[];
  /** Dimensions the interview left open — these block approval. */
  gaps: readonly IntentDimension[];
  status: IntentDocStatus;
  /** Set only once approved. */
  approvedBy?: string;
}

export type ApprovalResult = { ok: true; doc: IntentDoc } | { ok: false; blockers: readonly string[] };

/** Build the draft doc from a pinned interview. Pure: same result in, same IDs out. */
export function buildIntentDoc(result: InterviewResult): IntentDoc {
  const ordinals = new Map<IntentDimension, number>();
  const statements: IntentStatement[] = extractStatements(result).map((draft) => {
    const ordinal = (ordinals.get(draft.dimension) ?? 0) + 1;
    ordinals.set(draft.dimension, ordinal);
    return {
      id: formatIntentStatementId(draft.dimension, ordinal),
      dimension: draft.dimension,
      text: draft.text,
      source: draft.source,
    };
  });

  return {
    brainDump: result.brainDump,
    statements,
    gaps: result.gaps,
    status: 'draft',
  };
}

/** Human gate #1. Returns a NEW approved doc, or the blockers that stop approval. */
export function approveIntentDoc(doc: IntentDoc, approvedBy: string): ApprovalResult {
  const blockers: string[] = [];

  if (approvedBy.trim() === '') {
    blockers.push('approval needs a named approver');
  }
  if (doc.statements.length === 0) {
    blockers.push('the intent doc has no statements');
  }
  if (doc.gaps.length > 0) {
    blockers.push(`intent is not pinned: ${doc.gaps.join(', ')}`);
  }

  if (blockers.length > 0) {
    return { ok: false, blockers };
  }

  return { ok: true, doc: { ...doc, status: 'approved', approvedBy: approvedBy.trim() } };
}
