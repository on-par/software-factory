// src/cli/lane-heartbeat.ts — claim-lease heartbeat around an in-flight issue, split from run-lane.ts

/** How often an in-flight issue's claim lease is refreshed (#1500). Well inside the
 *  15-minute default lease (github-queue.ts's DEFAULT_CLAIM_LEASE_MS) so a normal poll
 *  cadence never lets the lease lapse mid-ship. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Runs `work` while periodically calling `heartbeat(issue)` so a long-running ship or
 *  merge wait keeps this claimant's lease fresh. A heartbeat failure is swallowed — losing
 *  one refresh must never abort the work it is protecting. Before returning or rethrowing, the
 *  timer is cleared and any in-flight tick is awaited, so no heartbeat write overlaps the
 *  caller's release of the claim (#3423). */
export async function withHeartbeat<T>(
  issue: number,
  heartbeat: ((issue: number) => Promise<unknown>) | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!heartbeat) return work();
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = Promise.resolve()
      .then(() => heartbeat(issue))
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        inFlight = undefined;
      });
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await inFlight;
  }
}
