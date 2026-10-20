import { existsSync } from 'node:fs';

import { ModelRouterError, type RouterAttempt } from './executor-error.js';

/** Whether the caller's worktree exists right now. `run()` records this before the first attempt so
 *  throwIfWorktreeMissing can tell a worktree removed mid-run apart from one that never existed. */
export function worktreeExists(worktree: string | undefined): boolean {
  return worktree !== undefined && existsSync(worktree);
}

/** After a failed attempt, throw when the caller's worktree is missing (#2964): every remaining model
 *  would fail the same way on the absent cwd, so this names the path instead of reporting a model
 *  failure. It says "removed while <model> was running" only when the worktree existed when the call
 *  started (`existedAtStart`); a path that was never there is reported as such, with the attempt's own
 *  failure detail, so a pre-absent path cannot pass for a concurrent removal. `beforeThrow` keeps the
 *  router's provider-breaker bookkeeping. No-op when no worktree was passed or it still exists. */
export async function throwIfWorktreeMissing(
  task: string,
  worktree: string | undefined,
  model: string,
  attempts: RouterAttempt[],
  onLog: (msg: string) => void,
  beforeThrow: () => Promise<void>,
  existedAtStart = true,
): Promise<void> {
  if (worktree === undefined || existsSync(worktree)) return;
  onLog(`Worktree ${worktree} no longer exists — not failing over`);
  await beforeThrow();
  if (existedAtStart) {
    throw new ModelRouterError(
      `Worktree missing for task '${task}': ${worktree} no longer exists (removed while ${model} was running) — not a model failure`,
      'error',
      attempts,
    );
  }
  const detail = attempts.at(-1)?.detail;
  throw new ModelRouterError(
    `Worktree missing for task '${task}': ${worktree} did not exist when the task started, so ${model} ran without it` +
      (detail ? ` (attempt failed: ${detail})` : ''),
    'error',
    attempts,
  );
}
