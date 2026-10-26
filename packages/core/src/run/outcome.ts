import type { AllProvidersDownPayload, EventKind } from '../events/kinds.js';

export type ParkReason = Extract<
  EventKind,
  | 'escalate'
  | 'timeout'
  | 'fail'
  | 'conflict'
  | 'ci-failed'
  | 'ci-infra'
  | 'ci-never-started'
  | 'held'
  | 'config'
  | 'blocked'
  | 'all_providers_down'
  | 'sandbox-env'
  | 'check-infra'
>;

import type { BuildRoutePin } from '../config/repo.js';

export type BuildRoute = BuildRoutePin;

/** Which model, provider and effort planned and built a run, stamped on its terminal events (#3321). */
export interface RunAttribution {
  plan?: { model: string; provider: string; effort?: string | boolean };
  build?: { model: string; provider: string; effort?: string | boolean };
  endedIn?: 'plan' | 'build' | 'check' | 'ship';
}

/** CHECK/CI rework reruns on the route BUILD completed on, `command` included (#2873):
 *  reworkWorker keeps it when its model can run and reroutes otherwise. */
export function reworkRouteFor(
  route: BuildRoute,
  model: string | undefined,
): { reworkRoute?: BuildRoutePin; reworkModel?: string } {
  return { reworkRoute: route, reworkModel: model };
}

/** A run's terminal outcome. `parked` is produced by the CLI's LaneParkError and `released`
 *  by an environment-caused CHECK failure (#1928, not a park); `shipped` / `ready` /
 *  `escalated` are defined here for later stories (#4, #5) that re-point the CLI
 *  supervisor and the sim onto this union. */
export type RunOutcome =
  | {
      state: 'shipped';
      route: BuildRoute;
      branch: string;
      reworkRounds: number;
      prNumber: number;
      attribution?: RunAttribution;
    }
  | {
      state: 'ready';
      route: BuildRoute;
      branch: string;
      reworkRounds: number;
      prNumber?: number;
      /** SHIP stopped at a draft PR (#3449); lanes must not merge it. */
      draft?: boolean;
      /** SHIP's CI watch timed out (#3569); the PR was left as draft. */
      ciPending?: boolean;
      /** the ADR-0147 slice this run shipped */
      slice?: { index: number; count: number };
      attribution?: RunAttribution;
    }
  | {
      state: 'parked';
      reason: ParkReason;
      /** Set only on a design-smell park (#1513). */
      designSmell?: DesignSmellFinding;
      route?: BuildRoute;
      branch?: string;
      reworkRounds?: number;
      prNumber?: number;
      /** CHECK failure signature (same value recorded in rework-history.json) — set only when CHECK parked the run (#1917). */
      failureSignature?: string;
      /** Names of the checkers that FAILed in that CHECK — set only alongside failureSignature. */
      failingChecks?: string[];
      /** Set on an `all_providers_down` park (#3235): the breaker-open providers the lane watches (metered ones excluded). */
      providersDown?: {
        stage: 'plan' | 'build' | 'check';
        providers: string[];
        detail: 'untimed_breakers' | 'only_metered_left';
      };
      attribution?: RunAttribution;
    }
  | {
      state: 'released';
      reason: 'environment';
      route?: BuildRoute;
      branch?: string;
      reworkRounds: number;
      /** Base SHA every failing checker also failed on (#1928). */
      baseSha: string;
      failingChecks: string[];
      /** Red only because a base compile timeout awaits green CI (#3186). */
      awaitingCi?: boolean;
      /** Red because a fresh local re-run confirmed a cached FAIL that CI calls green (#3287). */
      confirmedLocally?: boolean;
      failureSignature?: string;
      /** BUILD output was kept and a check-resume record written (#2564). */
      buildPreserved?: boolean;
      attribution?: RunAttribution;
    }
  | {
      /** ADR-0161: the stack slice below (`slice.index`, PR `prNumber`) awaits approval or merge, so the issue goes back to queued and is not parked. */
      state: 'released';
      reason: 'stack-wait';
      route?: BuildRoute;
      branch?: string;
      reworkRounds: number;
      prNumber: number;
      slice: { index: number; count: number };
      attribution?: RunAttribution;
    }
  | {
      /** #3576: PLAN touched `file`, which in-flight issue `holder` still claims; the issue goes back to queued, not parked. */
      state: 'released';
      reason: 'file-overlap';
      holder: number;
      file: string;
      route?: BuildRoute;
      branch?: string;
      reworkRounds: number;
      attribution?: RunAttribution;
    }
  | {
      /** #3226: every provider of the stage is capped; the issue goes back to queued (not parked) and the lane waits for `resetAt`. */
      state: 'released';
      reason: 'provider-cap';
      route?: BuildRoute;
      branch?: string;
      reworkRounds: number;
      /** Open providers of the blocked stage. */
      providers: string[];
      /** Earliest timed reset, ISO. */
      resetAt: string;
      /** #3340: the `all_providers_down` alert the lane emits once per transition into all-down. */
      allProvidersDown?: AllProvidersDownPayload;
      attribution?: RunAttribution;
    }
  | {
      state: 'escalated';
      reason: string;
      route?: BuildRoute;
      branch?: string;
      reworkRounds?: number;
      attribution?: RunAttribution;
    };

/** What redesign/spike learned when a design smell could not be resolved (#1513). */
export interface DesignSmellFinding {
  approachTried: string;
  whyItStinks: string;
  recommendation: string;
}

/** Core classifies structurally — via a parked RunOutcome on `err.outcome` or a
 *  `parkReason` marker property — rather than `instanceof`, because core cannot import
 *  the CLI's error classes (LaneParkError, LandConflictError, CiFailedError). */
export function parkReasonFor(err: unknown): ParkReason {
  const outcome = (err as { outcome?: RunOutcome } | null | undefined)?.outcome;
  if (outcome && outcome.state === 'parked') return outcome.reason;
  const marker = (err as { parkReason?: ParkReason } | null | undefined)?.parkReason;
  if (marker) return marker;
  if ((err as { reason?: unknown } | null | undefined)?.reason === 'timeout') return 'timeout';
  return 'fail';
}

/** The design-smell finding carried on a parked `err.outcome` or an `err.designSmell` marker; undefined unless all three fields are non-blank strings (#1513). */
export function designSmellFindingFor(err: unknown): DesignSmellFinding | undefined {
  const outcome = (err as { outcome?: RunOutcome } | null | undefined)?.outcome;
  const candidate: unknown =
    outcome && outcome.state === 'parked'
      ? outcome.designSmell
      : (err as { designSmell?: unknown } | null | undefined)?.designSmell;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const { approachTried, whyItStinks, recommendation } = candidate as Partial<
    Record<keyof DesignSmellFinding, unknown>
  >;
  const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!filled(approachTried) || !filled(whyItStinks) || !filled(recommendation)) return undefined;
  return { approachTried, whyItStinks, recommendation };
}

/** Terminal events to emit when a run parks. A timeout park additionally emits
 *  an explicit 'stuck' event so stuckRate observes runs that exceeded their
 *  phase timeout (#428). The other stuck condition — identical checker failures
 *  across consecutive rework rounds — is emitted by the check phase itself. */
export function parkEvents(err: unknown): { type: EventKind; msg: string; designSmell?: DesignSmellFinding }[] {
  const reason = parkReasonFor(err);
  const msg = err instanceof Error ? err.message : String(err);
  const designSmell = designSmellFindingFor(err);
  const events: { type: EventKind; msg: string; designSmell?: DesignSmellFinding }[] = [
    { type: reason, msg, ...(designSmell ? { designSmell } : {}) },
  ];
  if (reason === 'timeout') {
    events.push({ type: 'stuck', msg: `run exceeded its phase timeout without progressing — ${msg}` });
  }
  return events;
}
