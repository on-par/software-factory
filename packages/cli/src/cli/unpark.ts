import { createLogger } from '@on-par/factory-core';
import type { UnparkJson } from '@on-par/factory-core/internal';

export type { UnparkJson } from '@on-par/factory-core/internal';
export { runUnpark, UnparkError } from '@on-par/factory-core/internal';

/** Append one `issue_unparked` event; the silent sink keeps stdout untouched. Throws on a log failure. */
export function appendUnparkEvent(result: UnparkJson, eventsFile: string): void {
  createLogger(eventsFile, { lane: result.lane, issue: result.issue }, { out: { write: () => true } }).info(
    'issue_unparked',
    `#${result.issue} unparked → ${result.lane} (order ${result.order})`,
  );
}
