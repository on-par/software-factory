// packages/cli/src/cli/repo-live-run-lock.ts — fail-closed "does this attached repo have a live run?" check (#3643)
import { listLiveRunLocks } from '@on-par/factory-core/internal';
import { defaultIsPidAlive, getFactoryPaths } from '@on-par/factory-core';

/** True when the repo's run lock (checkout or per-issue) is held by a live pid. An unreadable
 *  issue-locks dir fails closed: the repo is treated as active. */
export function repoHasLiveRunLock(e: { path: string; stateRoot?: string }): boolean {
  try {
    return listLiveRunLocks(getFactoryPaths(e.path, e.stateRoot), defaultIsPidAlive).length > 0;
  } catch {
    return true;
  }
}
