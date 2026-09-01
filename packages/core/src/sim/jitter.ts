// packages/core/src/sim/jitter.ts — deterministic instability layer over the sim harness:
// per-phase delay distributions and failure-rate injection, applied at the two fake seams
// (the ModelExecutor and the fake octokit). Randomness is seeded and owned here, never taken
// from SimClock — see the ADR recorded with this change.

import { ModelExecutorError } from '../router/executor-error.js';
import type { ModelExecutor, ModelExecutorContext } from '../router/index.js';
import { realSimClock, resolveLatencyMs, type SimClock, type SimLatency } from './latency.js';
import type { SimOctokit } from './octokit.js';
import type { SimPhaseName } from './types.js';

/** The instability kinds the simulator can inject. */
export type SimFailureMode = 'timeout' | 'malformed_output' | 'rate_limit' | 'network_error';

/** Which fake double a draw was made for. */
export type SimJitterSeam = 'model' | 'github';

/** Every mode, in the order used for uniform mode selection. */
export const SIM_FAILURE_MODES = [
  'timeout',
  'malformed_output',
  'rate_limit',
  'network_error',
] as const satisfies readonly SimFailureMode[];

/** Resolved output of a malformed-output injection: non-empty (so the router does not
 *  classify it as empty_response) and not parsable as a spec or an escalation. */
export const SIM_MALFORMED_OUTPUT = '<<sim jitter: malformed model output>> {"unterminated":';

export interface SimPhaseJitter {
  /** Delay applied to every simulated call made while this phase is running. */
  delay?: SimLatency;
  /** Probability in [0, 1] that a call in this phase fails. Clamped. Defaults to 0. */
  failureRate?: number;
  /** Modes drawn uniformly when a failure fires. Empty or absent means all of SIM_FAILURE_MODES. */
  failureModes?: SimFailureMode[];
}

export interface SimJitterConfig {
  /** Seeds the PRNG. The same seed replays the exact same delays and failures. */
  seed: number;
  /** Used for any phase with no explicit entry. A per-phase entry replaces it wholesale — the
   *  two are never merged field-by-field. */
  default?: SimPhaseJitter;
  phases?: Partial<Record<SimPhaseName, SimPhaseJitter>>;
}

/** One injection decision, recorded in call order. This sequence is what "deterministic" means. */
export interface SimJitterDraw {
  phase: SimPhaseName;
  seam: SimJitterSeam;
  /** Delay actually applied to this call, in ms. */
  delayMs: number;
  /** The injected failure, or null when the call was allowed through. */
  failure: SimFailureMode | null;
}

/** mulberry32 — small, fast, and stable across Node versions (no host RNG involved). */
export function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-issue seed so an outcome's draw stream never depends on its position in the batch. */
export function deriveSimSeed(seed: number, issue: number): number {
  return ((seed >>> 0) ^ (Math.imul(issue >>> 0, 2654435761) >>> 0)) >>> 0;
}

export class SimJitter {
  /** Every draw this instance made, in order. */
  readonly draws: SimJitterDraw[] = [];
  private random: () => number;

  constructor(
    private config: SimJitterConfig,
    seedOverride?: number,
  ) {
    this.random = createSeededRandom(seedOverride ?? config.seed);
  }

  next(phase: SimPhaseName, seam: SimJitterSeam): SimJitterDraw {
    // Always consume exactly three values, in this order, before branching — the draw width
    // is a compatibility contract (see the ADR): changing it invalidates seed-keyed baselines.
    const delayRandom = this.random();
    const failureRandom = this.random();
    const modeRandom = this.random();

    const settings = this.config.phases?.[phase] ?? this.config.default ?? {};
    const delayMs = resolveLatencyMs(settings.delay, () => delayRandom);
    const rate = Math.min(1, Math.max(0, settings.failureRate ?? 0));
    const modes = settings.failureModes?.length ? settings.failureModes : SIM_FAILURE_MODES;
    const failure =
      failureRandom < rate ? (modes[Math.min(modes.length - 1, Math.floor(modeRandom * modes.length))] ?? null) : null;

    const draw: SimJitterDraw = { phase, seam, delayMs, failure };
    this.draws.push(draw);
    return draw;
  }
}

/** Wraps any ModelExecutor so every call first consults the jitter for the phase currently
 *  executing. An injected failure never reaches the inner executor, so it never consumes a
 *  scripted SimModelStep — router retries replay against the same script position. */
export class SimJitterExecutor implements ModelExecutor {
  constructor(
    private inner: ModelExecutor,
    private jitter: SimJitter,
    private phaseOf: () => SimPhaseName,
    private clock: SimClock = realSimClock,
  ) {}

  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    const draw = this.jitter.next(this.phaseOf(), 'model');
    if (draw.delayMs > 0) await this.clock.sleep(draw.delayMs);
    switch (draw.failure) {
      case 'timeout':
        throw new ModelExecutorError('sim jitter: model call timed out', 'timeout', { exitCode: 124 });
      case 'rate_limit':
        throw new ModelExecutorError('sim jitter: rate limited', 'rate_limit', { exitCode: 1 });
      case 'network_error':
        throw new ModelExecutorError('sim jitter: network error (ECONNRESET)', 'unavailable', { exitCode: 1 });
      case 'malformed_output':
        return SIM_MALFORMED_OUTPUT;
      default:
        return this.inner.runModel(model, prompt, ctx);
    }
  }
}

function githubJitterError(mode: SimFailureMode): Error {
  switch (mode) {
    case 'timeout':
      return new Error('sim jitter: GitHub request timed out');
    case 'rate_limit':
      return new Error('sim jitter: GitHub API rate limit exceeded');
    case 'network_error':
      return new Error('sim jitter: GitHub network error (ECONNRESET)');
    case 'malformed_output':
      // The fake octokit has no partial-response contract to violate, so a malformed GitHub
      // response is modelled as an unusable one — a rejection, like the other three.
      return new Error('sim jitter: malformed GitHub response');
  }
}

/** Wraps a SimOctokit so every fake GitHub call consults the jitter for the phase currently
 *  executing. Preserves the recorded-call log of the wrapped client — the wrapper delegates. */
export function withSimJitter(
  octokit: SimOctokit,
  jitter: SimJitter,
  phaseOf: () => SimPhaseName,
  clock: SimClock = realSimClock,
): SimOctokit {
  async function gate(): Promise<void> {
    const draw = jitter.next(phaseOf(), 'github');
    if (draw.delayMs > 0) await clock.sleep(draw.delayMs);
    if (draw.failure) throw githubJitterError(draw.failure);
  }

  return {
    graphql: async (query, vars) => {
      await gate();
      return octokit.graphql(query, vars);
    },
    rest: {
      issues: {
        get: async (args) => {
          await gate();
          return octokit.rest.issues.get(args);
        },
        update: async (args) => {
          await gate();
          return octokit.rest.issues.update(args);
        },
      },
      pulls: {
        list: async (args) => {
          await gate();
          return octokit.rest.pulls.list(args);
        },
        create: async (args) => {
          await gate();
          return octokit.rest.pulls.create(args);
        },
        get: async (args) => {
          await gate();
          return octokit.rest.pulls.get(args);
        },
      },
      checks: {
        listForRef: async (args) => {
          await gate();
          return octokit.rest.checks.listForRef(args);
        },
      },
    },
  };
}
