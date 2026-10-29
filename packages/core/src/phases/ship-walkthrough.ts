// src/phases/ship-walkthrough.ts — best-effort large-PR walkthrough for SHIP (#3623)

import type { EventKind } from '../events/kinds.js';
import {
  meetsWalkthroughThreshold,
  parseNumstat,
  renderPrWalkthrough,
  resolveWalkthroughThresholds,
  type WalkthroughThresholds,
} from '../reports/pr-walkthrough.js';
import type { CheckSummary } from '../types/index.js';
import { computeNumstat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';
import { shortDetail } from './ship-git.js';
import { readSpecBody } from './ship-spec.js';

export interface WalkthroughShipOpts {
  specPath?: string;
  checkSummary?: CheckSummary;
  /** pr.walkthrough thresholds (#3623); undefined uses the defaults. */
  walkthrough?: Partial<WalkthroughThresholds>;
  /** The PR's base branch; the size threshold diffs against it, so a stacked PR counts only its own changes. */
  base: string;
}

/** Memoised walkthrough builder: the markdown (undefined below the thresholds), built at most once. A failure is a `warn`, never a throw. */
export function lazyWalkthrough(
  run: CommandRunner,
  worktree: string,
  opts: WalkthroughShipOpts,
  log: (type: EventKind, msg: string) => void,
): () => Promise<string | undefined> {
  let built: Promise<string | undefined> | undefined;
  return () => (built ??= buildWalkthrough(run, worktree, opts, log));
}

async function buildWalkthrough(
  run: CommandRunner,
  worktree: string,
  opts: WalkthroughShipOpts,
  log: (type: EventKind, msg: string) => void,
): Promise<string | undefined> {
  try {
    const files = parseNumstat(await computeNumstat(run, worktree, opts.base));
    if (!meetsWalkthroughThreshold(files, resolveWalkthroughThresholds(opts.walkthrough))) return undefined;
    const md = renderPrWalkthrough({
      specBody: await readSpecBody(opts.specPath),
      checkSummary: opts.checkSummary,
    });
    log('evidence', `walkthrough generated (${files.length} files)`);
    return md;
  } catch (err) {
    log('warn', `walkthrough skipped: ${shortDetail(err)}`);
    return undefined;
  }
}
