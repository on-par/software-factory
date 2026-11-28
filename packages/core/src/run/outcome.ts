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
  | 'ci-rework-no-change'
  | 'ci-flaky'
  | 'held'
  | 'config'
  | 'blocked'
  | 'all_providers_down'
  | 'sandbox-env'
  | 'check-infra'
  | 'time-budget'
  | 'not-ready'
>;

import type { BuildRoutePin } from '../config/repo.js';
import type { ShipDraftReason, ShipResult } from '../phases/ship-types.js';
import type { BaseHealthEvidence } from '../checkers/base-health.js';
import type { RemainingWorkHandoff } from './handoff.js';

export type BuildRoute = BuildRoutePin;

export interface RunAttribution {
  plan?: { model: string; provider: string; effort?: string | boolean };
  build?: { model: string; provider: string; effort?: string | boolean };
  endedIn?: 'plan' | 'build' | 'check' | 'ship';
}

export function reworkRouteFor(
  route: BuildRoute,
  model: string | undefined,
): { reworkRoute?: BuildRoutePin; reworkModel?: string } {
  return { reworkRoute: route, reworkModel: model };
}

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
      draft?: boolean;
      ciPending?: boolean;
      ciWatched?: false;
      draftReason?: ShipDraftReason;
      slice?: { index: number; count: number };
      attribution?: RunAttribution;
    }
  | {
      state: 'parked';
      reason: ParkReason;
      designSmell?: DesignSmellFinding;
      route?: BuildRoute;
      branch?: string;
      reworkRounds?: number;
      prNumber?: number;
      failureSignature?: string;
      failingChecks?: string[];
      providersDown?: {
        stage: 'plan' | 'build' | 'check';
        providers: string[];
        detail: 'untimed_breakers' | 'only_metered_left';
      };
      handoff?: RemainingWorkHandoff;
      attribution?: RunAttribution;
    }
  | {
      state: 'released';
      reason: 'environment';
      route?: BuildRoute;
      branch?: string;
      reworkRounds: number;
      baseSha: string;
      failingChecks: string[];
      awaitingCi?: boolean;
      confirmedLocally?: boolean;
      baseEvidence?: BaseHealthEvidence[];
      baseInconclusive?: true;
      failureSignature?: string;
      buildPreserved?: boolean;
      attribution?: RunAttribution;
    }
  | {
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
      state: 'released';
      reason: 'provider-cap';
      route?: BuildRoute;
      branch?: string;
      reworkRounds: number;
      providers: string[];
      resetAt: string;
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

export interface DesignSmellFinding {
  approachTried: string;
  whyItStinks: string;
  recommendation: string;
}

export function parkReasonFor(err: unknown): ParkReason {
  const outcome = (err as { outcome?: RunOutcome } | null | undefined)?.outcome;
  if (outcome && outcome.state === 'parked') return outcome.reason;
  const marker = (err as { parkReason?: ParkReason } | null | undefined)?.parkReason;
  if (marker) return marker;
  if ((err as { reason?: unknown } | null | undefined)?.reason === 'timeout') return 'timeout';
  return 'fail';
}

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

export function readyDraftFields(ship: Pick<ShipResult, 'draft' | 'ciPending' | 'draftReason'>): {
  draft?: true;
  ciPending?: true;
  draftReason?: ShipDraftReason;
} {
  return {
    ...(ship.draft ? { draft: true } : {}),
    ...(ship.ciPending ? { ciPending: true } : {}),
    ...(ship.draftReason ? { draftReason: ship.draftReason } : {}),
  };
}
