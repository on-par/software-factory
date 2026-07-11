const tails = new Map<string, Promise<unknown>>();

/**
 * Serializes async work per key within this process. The next waiter proceeds
 * after the previous call settles, whether it resolves or rejects, so throwing
 * operations release the lock. Cross-process locking is intentionally out of
 * scope for the current single-process lane model.
 */
export function withGitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => {}, () => {});

  tails.set(key, tail);
  tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}
