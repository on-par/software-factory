// packages/product/src/intent/trace.ts — grade downstream artifacts against the doc (#471).

import type { IntentStatementId, Traceable } from '@on-par/contracts';

import type { IntentDoc } from './intent-doc.js';

export interface TraceReport {
  ok: boolean;
  /** Referenced by an artifact but not defined in the doc (dangling or malformed). */
  unknownIds: readonly string[];
  /** Defined in the doc but nothing traces to it. */
  untracedIds: readonly IntentStatementId[];
}

/** Grade downstream artifacts against the doc: does every reference land, and is every statement claimed? */
export function checkTraceability(doc: IntentDoc, artifacts: readonly Traceable[]): TraceReport {
  const known = new Set<string>(doc.statements.map((statement) => statement.id));
  const referenced = artifacts.flatMap((artifact) => artifact.tracesTo ?? []);
  const referencedSet = new Set(referenced);

  const unknownIds: string[] = [];
  const seenUnknown = new Set<string>();
  for (const id of referenced) {
    if (!known.has(id) && !seenUnknown.has(id)) {
      seenUnknown.add(id);
      unknownIds.push(id);
    }
  }

  const untracedIds = doc.statements.map((statement) => statement.id).filter((id) => !referencedSet.has(id));

  return { ok: unknownIds.length === 0 && untracedIds.length === 0, unknownIds, untracedIds };
}
