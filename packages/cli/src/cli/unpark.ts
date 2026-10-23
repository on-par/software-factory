import type { Octokit } from '@octokit/rest';
import { createLogger } from '@on-par/factory-core';
import { readParkedOrder, type UnparkInput, type UnparkJson } from '@on-par/factory-core/internal';

export type { UnparkJson } from '@on-par/factory-core/internal';
export { runUnpark, UnparkError } from '@on-par/factory-core/internal';

/** Append one `issue_unparked` event; the silent sink keeps stdout untouched. Throws on a log failure. */
export function appendUnparkEvent(result: UnparkJson, eventsFile: string): void {
  createLogger(eventsFile, { lane: result.lane, issue: result.issue }, { out: { write: () => true } }).info(
    'issue_unparked',
    `#${result.issue} unparked → ${result.lane} (order ${result.order})`,
  );
}

/** Options `factory unpark` accepts. */
export interface UnparkOpts {
  lane?: string;
  json?: boolean;
  keepOrder?: boolean;
}

/** `--keep-order` input for runUnpark: restores the order recorded in the issue's park-state comment (#3554). */
export function keepOrderInput(
  keepOrder: boolean | undefined,
  octokit: Octokit,
  repo: string,
  issue: number,
): Pick<UnparkInput, 'keepOrder' | 'readParkedOrder'> {
  return keepOrder ? { keepOrder: true, readParkedOrder: () => readParkedOrder({ octokit, repo, issue }) } : {};
}
