import { existsSync } from 'node:fs';

import { ModelRouterError, type RouterAttempt } from './executor-error.js';

/** After a failed attempt, throw when the caller's worktree vanished while the model ran (#2964):
 *  every remaining model would fail the same way on the deleted cwd, so this names the path instead
 *  of reporting a model failure. `beforeThrow` keeps the router's provider-breaker bookkeeping.
 *  No-op when no worktree was passed or it still exists. */
export async function throwIfWorktreeMissing(
  task: string,
  worktree: string | undefined,
  model: string,
  attempts: RouterAttempt[],
  onLog: (msg: string) => void,
  beforeThrow: () => Promise<void>,
): Promise<void> {
  if (worktree === undefined || existsSync(worktree)) return;
  onLog(`Worktree ${worktree} no longer exists — not failing over`);
  await beforeThrow();
  throw new ModelRouterError(
    `Worktree missing for task '${task}': ${worktree} no longer exists (removed while ${model} was running) — not a model failure`,
    'error',
    attempts,
  );
}
