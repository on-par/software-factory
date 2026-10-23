// packages/cli/src/cli/run-lane-rebuild.ts — the lane's one rebuild after a merge-main conflict at land (#3325)

import { phaseSnapshotFile, readPhaseSnapshot } from '@on-par/factory-core';
import type { getFactoryPaths, RunOutcome } from '@on-par/factory-core';
import type { logEvent } from '@on-par/factory-core/internal';

import { withHeartbeat } from './lane-heartbeat.js';
import { LandRebuildRequiredError } from './land-pr.js';
import { isRebuildBranch, rebuildConflictedPr } from './land-rebuild.js';

/** Ships the issue again on the rebuild branch through the lane's own ship, then replaces the old PR. */
export function rebuildInLane(opts: {
  issue: number;
  lane: string;
  paths: ReturnType<typeof getFactoryPaths>;
  conflict: LandRebuildRequiredError;
  /** The lane's ship, already bound to this issue; the callback receives the rebuild's RunOutcome. */
  ship: (rebuild: { branch: string }, onOutcome: (outcome: RunOutcome) => void) => Promise<string>;
  replacePr?: (issue: number, oldPr: number, newPr: number, paths: string[]) => Promise<void>;
  emitEvent: typeof logEvent;
}): Promise<{ branch: string; prNumber: number }> {
  const { issue, lane, paths, emitEvent } = opts;
  return rebuildConflictedPr({
    issue,
    conflict: opts.conflict,
    ship: async (rebuild) => {
      let outcome: RunOutcome | undefined;
      const branch = await opts.ship(rebuild, (o) => {
        outcome = o;
      });
      return { branch, outcome };
    },
    replacePr: opts.replacePr ?? (async () => {}),
    readStage: async () => (await readPhaseSnapshot(phaseSnapshotFile(paths.runs, issue)))?.phase ?? null,
    log: (type, msg, extra) => emitEvent(paths.events, type, issue, msg, { lane, ...extra }),
  });
}

/**
 * Lands `branch`. A merge-main conflict on a real path is rebuilt once (the lane stays the only builder),
 * then the rebuilt branch lands with no further rebuild, so a second conflict parks (#3325).
 */
export async function landWithOneRebuild(opts: {
  issue: number;
  branch: string;
  syncMain: boolean;
  /** The lane's claim heartbeat; the land and the rebuild's ship each run under it. */
  heartbeat: Parameters<typeof withHeartbeat>[1];
  land: (branch: string, landOpts: { syncMain?: boolean; rebuildOnConflict: boolean }) => Promise<void>;
  /** The rebuild's settings: the lane, paths, ship, replacePr and emitEvent of `rebuildInLane`. */
  rebuild: Omit<Parameters<typeof rebuildInLane>[0], 'conflict' | 'issue'>;
  /** Called with the rebuilt branch before it lands, so the caller settles the right PR on a later failure. */
  onRebuilt: (branch: string) => void;
}): Promise<void> {
  const { issue } = opts;
  const land = (branch: string, landOpts: Parameters<typeof opts.land>[1]) =>
    withHeartbeat(issue, opts.heartbeat, () => opts.land(branch, landOpts));
  try {
    await land(opts.branch, { syncMain: opts.syncMain, rebuildOnConflict: !isRebuildBranch(opts.branch) });
  } catch (err) {
    if (!(err instanceof LandRebuildRequiredError)) throw err;
    const rebuilt = await rebuildInLane({
      ...opts.rebuild,
      issue,
      conflict: err,
      ship: (rebuild, onOutcome) => withHeartbeat(issue, opts.heartbeat, () => opts.rebuild.ship(rebuild, onOutcome)),
    });
    opts.onRebuilt(rebuilt.branch);
    await land(rebuilt.branch, { rebuildOnConflict: false });
  }
}
