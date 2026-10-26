// packages/core/src/run/environment-lease.ts — a failed environment lease degrades the run instead of parking it

import type { Environment } from './ports.js';

/** Leases the lane environment; a failed lease is logged and the run continues without an injected PORT. */
export async function leaseEnvironmentOrWarn(
  acquire: () => Promise<Environment>,
  log: (type: 'environment_lease_failed', msg: string) => void,
): Promise<Environment | undefined> {
  try {
    return await acquire();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('environment_lease_failed', `port lease unavailable (${reason}) — running without injected PORT`);
    return undefined;
  }
}

/** Releases the lane environment's port; a failed release is logged, never thrown. */
export async function releaseEnvironmentOrWarn(
  environment: Environment,
  worktree: string,
  log: (type: 'environment_release' | 'environment_release_failed', msg: string) => void,
): Promise<void> {
  try {
    await environment.release();
    log('environment_release', `released port ${environment.port} for worktree ${worktree}`);
  } catch (err) {
    log('environment_release_failed', `port release failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
