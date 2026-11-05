// packages/cli/src/cli/land-slot.ts — host landing slot: an exclusive hold for a land-deferred retry (#3957)

import type { EventKind } from '@on-par/factory-core';
import { withFileLock, withGitLock } from '@on-par/factory-core/internal';

import type { LandLock } from './land-pr.js';

/** A retry holds the slot across sync, CI watch and merge, so a queued land can wait several CI watches. */
export const LANDING_SLOT_WAIT_MS = 4 * 60 * 60_000;

/** Runs `fn` while holding the host landing slot. Lock order is always slot → git → merge. */
export function withLandingSlot<T>(
  paths: { landSlotLock: string },
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number; onSteal?: (pid: number | null) => void },
): Promise<T> {
  return withFileLock(paths.landSlotLock, fn, {
    timeoutMs: opts?.timeoutMs ?? LANDING_SLOT_WAIT_MS,
    ...(opts?.onSteal ? { onSteal: opts.onSteal } : {}),
  });
}

/** The land lock for one landIssue call: git lock → merge lock, wrapped in the landing slot unless the caller
 *  already holds it (the file lock is not re-entrant, so a nested acquisition would self-deadlock). */
export function landLockFor(
  repoRoot: string,
  paths: { mergeLock: string; landSlotLock: string },
  log: (type: EventKind, msg: string) => void,
  holdsLandingSlot: boolean,
): LandLock {
  const inner: LandLock = (fn) =>
    withGitLock(repoRoot, () =>
      withFileLock(paths.mergeLock, fn, {
        onSteal: (pid) => log('lock-stolen', `stole ${paths.mergeLock} from dead holder pid ${pid ?? 'unknown'}`),
      }),
    );
  if (holdsLandingSlot) return inner;
  return (fn) =>
    withLandingSlot(
      paths,
      () => inner(fn),
      {
        onSteal: (pid) => log('lock-stolen', `stole ${paths.landSlotLock} from dead holder pid ${pid ?? 'unknown'}`),
      },
    );
}
