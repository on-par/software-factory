import { styleText } from 'node:util';

import type { Octokit } from '@octokit/rest';

import { LaneFileGuard, type getFactoryPaths, type QueueDiagnostic } from '@on-par/factory-core';
import {
  createGithubLaneClaimStalenessProbe,
  createOctokitQueueClient,
  logEvent,
  releaseStaleClaims,
  resolveBranchPrefix,
  unqueueDeferredOnly,
} from '@on-par/factory-core/internal';
import type { QueueDeferCause } from './queue-preflight.js';
import { runOrphanDraftSweep } from './orphan-draft-sweep.js';

export function warnQueueDiagnostics(diagnostics: QueueDiagnostic[]): void {
  for (const d of diagnostics) {
    console.error(styleText('yellow', `factory: queue ${d.message} — skipped`));
  }
}

/** Startup / queue-reconcile stale lane-claim sweep (#3065). Never throws — a failure is a
 *  warn, never a reason to abort the command. `getOctokit` returns undefined when there is no
 *  GitHub token, which skips the sweep. */
export async function sweepLaneClaims(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  getOctokit: () => Octokit | undefined,
): Promise<void> {
  try {
    const octokit = getOctokit();
    if (!octokit) return;
    await new LaneFileGuard(paths.laneFiles).sweepStale({
      repo: ghRepo,
      isStale: createGithubLaneClaimStalenessProbe({ octokit, branchPrefix: resolveBranchPrefix() }),
      log: (type, msg) => logEvent(paths.events, type, 'all', msg),
    });
  } catch (err: any) {
    logEvent(paths.events, 'warn', 'all', `lane claim sweep failed: ${err?.message ?? String(err)}`);
  }
}

/** Per-cycle expired GitHub claim reap (#3660): claims whose factory:claim-expires lease is past go back to
 *  factory:queued without waiting for doctor --reconcile. Never throws — a failure is a warn. */
export async function reapExpiredClaims(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  getOctokit: () => Octokit | undefined,
  release: typeof releaseStaleClaims = releaseStaleClaims,
): Promise<void> {
  try {
    const octokit = getOctokit();
    if (!octokit) return;
    const [owner, repo] = ghRepo.split('/');
    for (const r of await release({ client: createOctokitQueueClient(octokit), owner, repo })) {
      if (r.outcome === 'released') {
        logEvent(
          paths.events,
          'claim_expired_released',
          r.issue,
          `#${r.issue} claim lease expired at ${new Date(r.expiresAt * 1000).toISOString()} — released (${r.label})`,
        );
      } else if (r.outcome === 'failed') {
        logEvent(paths.events, 'warn', r.issue, `expired claim release for #${r.issue} failed: ${r.detail}`);
      }
    }
  } catch (err: any) {
    logEvent(paths.events, 'warn', 'all', `expired claim reap failed: ${err?.message ?? String(err)}`);
  }
}

/** Logs each deferred issue once per run, and remembers which were deferred on open prerequisites (#3660). */
export function createDeferralTracker(eventsFile: string) {
  const seen = new Set<number>();
  const prerequisite = new Set<number>();
  return {
    prerequisite,
    onDeferred: (issue: number, message: string, cause?: QueueDeferCause) => {
      if (cause === 'open-prerequisites') prerequisite.add(issue);
      if (seen.has(issue)) return;
      seen.add(issue);
      logEvent(eventsFile, 'issue_deferred', issue, message);
    },
  };
}

/** End-of-cycle settle (#3660): when every queued issue left in the planned lanes was deferred on open
 *  prerequisites, drop factory:queued from them and say so loudly. Never throws. */
export async function settleDeferredOnly(
  paths: ReturnType<typeof getFactoryPaths>,
  ghRepo: string,
  getOctokit: () => Octokit | undefined,
  lanes: readonly { lane: string }[],
  deferred: ReadonlySet<number>,
): Promise<void> {
  try {
    const octokit = getOctokit();
    if (!octokit || lanes.length === 0) return;
    const [owner, repo] = ghRepo.split('/');
    const res = await unqueueDeferredOnly({
      client: createOctokitQueueClient(octokit),
      owner,
      repo,
      lanes: lanes.map((l) => l.lane),
      deferred,
    });
    if (res.verdict !== 'deferred-only' || res.unqueued.length === 0) return;
    const msg = `queue deferred-only: ${res.unqueued.map((n) => `#${n}`).join(', ')} waiting on open prerequisites — removed factory:queued; re-add it once prerequisites close`;
    console.log(styleText('yellow', `!! ${msg}`));
    logEvent(paths.events, 'queue_deferred_only', 'all', msg);
  } catch (err: any) {
    logEvent(paths.events, 'warn', 'all', `deferred-only settle failed: ${err?.message ?? String(err)}`);
  }
}

/** The `factory run` startup sweeps bound to one octokit getter (undefined without a GitHub token). */
export function startupSweeps(getOctokit: () => Octokit | undefined) {
  type Paths = ReturnType<typeof getFactoryPaths>;
  return {
    sweepStaleLaneClaims: (paths: Paths, ghRepo: string) => sweepLaneClaims(paths, ghRepo, getOctokit),
    sweepOrphanDrafts: (paths: Paths, ghRepo: string) => runOrphanDraftSweep(paths, ghRepo, getOctokit),
    reapExpiredClaims: (paths: Paths, ghRepo: string) => reapExpiredClaims(paths, ghRepo, getOctokit),
  };
}
