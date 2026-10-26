// packages/cli/src/cli/lane-file-hold.ts — numeric adapter from the WorkKey-based lane-file guard to the queue preflight's hold lookup (ADR-0168).
import { issueNumberOf, LaneFileGuard, workKeyFromIssue } from '@on-par/factory-core';

import type { LaneFileHoldLookup } from './queue-preflight.js';

/** The queue preflight (out of scope for the WorkKey migration) still speaks issue numbers. */
export function laneFileHoldLookup(laneFiles: string, ghRepo: string): LaneFileHoldLookup {
  return async (n) => {
    const hold = await new LaneFileGuard(laneFiles).liveHold(ghRepo, workKeyFromIssue(n));
    return hold && { holder: issueNumberOf(hold.holder), file: hold.file };
  };
}
