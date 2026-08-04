// packages/core/src/sim/latency.ts — shared timing primitive for the sim harness.
// Zero imports outside node built-ins so it can be reused by any sim double.

/** Fixed milliseconds, an explicit fixed spec, or a uniform distribution. */
export type SimLatency = number | { fixedMs: number } | { minMs: number; maxMs: number };

/** Injectable time + randomness so harness tests are deterministic without global fake timers. */
export interface SimClock {
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const realSimClock: SimClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export function resolveLatencyMs(latency: SimLatency | undefined, random: () => number): number {
  if (latency === undefined) return 0;
  if (typeof latency === 'number') return Math.max(0, latency);
  if ('fixedMs' in latency) return Math.max(0, latency.fixedMs);
  const { minMs, maxMs } = latency;
  if (maxMs < minMs) return Math.max(0, minMs);
  return Math.max(0, Math.round(minMs + random() * (maxMs - minMs)));
}

export async function applyLatency(latency: SimLatency | undefined, clock: SimClock): Promise<number> {
  const ms = resolveLatencyMs(latency, clock.random);
  if (ms > 0) await clock.sleep(ms);
  return ms;
}
