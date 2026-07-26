// packages/product/src/intent/render.ts — human-readable intent doc markdown (#471).

import { INTENT_DIMENSIONS, probeFor } from '../interview/index.js';
import type { IntentDoc } from './intent-doc.js';

/** Human-readable markdown lines for the CLI and the handoff bundle. */
export function renderIntentDoc(doc: IntentDoc): string[] {
  const lines: string[] = ['# Intent Doc', `Status: ${doc.status}`];

  if (doc.approvedBy !== undefined) {
    lines.push(`Approved by: ${doc.approvedBy}`);
  }

  lines.push(
    `Statements: ${doc.statements.length}; open gaps: ${doc.gaps.length > 0 ? doc.gaps.join(', ') : '(none)'}`,
  );

  for (const dimension of INTENT_DIMENSIONS) {
    const statements = doc.statements.filter((statement) => statement.dimension === dimension);
    if (statements.length === 0) {
      continue;
    }
    lines.push('', `## ${probeFor(dimension).label}`);
    for (const statement of statements) {
      lines.push(`- ${statement.id} — ${statement.text}`);
    }
  }

  return lines;
}
