// packages/cli/src/cli/repo-run-lock.ts — withRepoRunLock, the CLI's run-lock wrapper (#598, #3643)
import {
  logEvent,
  RunLockHeldError,
  runLockDirFor,
  withScopedRunLock,
  type RunLockScope,
} from '@on-par/factory-core/internal';
import type { getFactoryPaths } from '@on-par/factory-core';

import { CliExitError } from './errors.js';

/** Fences a whole run behind a run lock (#598, #3643): by default the checkout-wide
 *  `.factory/run.lock`, or with `deps.scope` a per-issue `.factory/locks/run/<WorkKey>` lock
 *  that lets one-shot runs on different issues share a checkout. A live holder is
 *  refused immediately — never queued behind a multi-hour run — and a dead holder's lock is
 *  reclaimed by withRunLock. Nested acquisition inside one process is a pass-through, so
 *  `factory supervise` can hold this across its loop. */
export async function withRepoRunLock<T>(
  paths: ReturnType<typeof getFactoryPaths>,
  command: string,
  fn: () => Promise<T>,
  deps: { scope?: RunLockScope; runLock?: typeof withScopedRunLock; emitEvent?: typeof logEvent } = {},
): Promise<T> {
  const { scope = { kind: 'checkout' }, runLock = withScopedRunLock, emitEvent = logEvent } = deps;
  try {
    return await runLock(paths, scope, fn, {
      command,
      onReclaim: (pid) =>
        emitEvent(
          paths.events,
          'lock-stolen',
          '-',
          `reclaimed ${runLockDirFor(paths, scope)} from dead holder pid ${pid ?? 'unknown'}`,
        ),
    });
  } catch (err) {
    if (err instanceof RunLockHeldError) {
      emitEvent(paths.events, 'run_lock_conflict', '-', `${command} refused: ${err.message}`);
      throw new CliExitError(
        `factory: ${err.message} — stop that run (or wait for it to finish) before starting another. ` +
          `A dead run's lock is reclaimed automatically; remove ${err.lockDir} only if you are sure no factory run is live.`,
        2,
      );
    }
    throw err;
  }
}
