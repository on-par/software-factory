// packages/cli/src/cli/daemon-launchctl.ts — bootout/bootstrap sequencing for `factory daemon start` (#2922).

import type { LaunchctlExec } from './daemon.js';

/** Upper bound on waiting for launchd to drop the job after bootout (#2922). */
export const BOOTOUT_WAIT_MS = 10_000;
export const BOOTOUT_POLL_MS = 250;
/** Total bootstrap attempts when launchctl returns 5 (EIO) (#2922). */
export const BOOTSTRAP_ATTEMPTS = 4;
export const BOOTSTRAP_RETRY_MS = 500;
export const LAUNCHCTL_EIO = 5;

/** bootout the job, wait (bounded) until launchd has dropped it, then bootstrap,
 *  retrying a transient EIO with a linear backoff. Returns the last bootstrap result. */
export async function reloadLaunchAgent(
  d: { exec: LaunchctlExec; sleep: (ms: number) => Promise<void>; uid: number },
  target: string,
  plistPath: string,
): ReturnType<LaunchctlExec> {
  const out = await d.exec('launchctl', ['bootout', target]);
  if (out.code === 0) {
    // bootout returns before launchd finishes tearing the job down.
    for (let i = 0; i < Math.ceil(BOOTOUT_WAIT_MS / BOOTOUT_POLL_MS); i++) {
      if ((await d.exec('launchctl', ['print', target])).code !== 0) break;
      await d.sleep(BOOTOUT_POLL_MS);
    }
  }
  let boot = await d.exec('launchctl', ['bootstrap', `gui/${d.uid}`, plistPath]);
  for (let attempt = 1; boot.code === LAUNCHCTL_EIO && attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
    await d.sleep(BOOTSTRAP_RETRY_MS * attempt);
    boot = await d.exec('launchctl', ['bootstrap', `gui/${d.uid}`, plistPath]);
  }
  return boot;
}

/** The DaemonCtlError message for a non-zero bootstrap result. */
export function bootstrapFailureMessage(boot: Awaited<ReturnType<LaunchctlExec>>): string {
  const exhausted = boot.code === LAUNCHCTL_EIO ? ` (after ${BOOTSTRAP_ATTEMPTS} attempts)` : '';
  return `launchctl bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim() || `exit ${boot.code}`}${exhausted}`;
}
