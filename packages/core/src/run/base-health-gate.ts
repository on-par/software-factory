// src/run/base-health-gate.ts — what runIssue does with the pre-PLAN base health verdict (#2339, #3989).
// A red or inconclusive base releases the issue before any model call. An explicit base-repair run
// (RunRequest.baseHealthRepair, set by `run-issue` from FACTORY_BASE_HEALTH_REPAIR=1) proceeds to PLAN on a
// confirmed red base instead, because its job is to fix that base. It never proceeds on an inconclusive base
// (a check that could not run) or on a red that only awaits CI for a timed-out compile: those still release.

import {
  type BaseHealthResult,
  baseHealthReleasedMessage,
  describeBaseHealthEvidence,
} from '../checkers/base-health.js';
import type { EventKind } from '../events/kinds.js';
import type { RunOutcome } from './outcome.js';

export interface BaseHealthGateOptions {
  /** The base ref base health tested, e.g. origin/main. */
  ref: string;
  workKey: string | number;
  branch: string;
  /** RunRequest.baseHealthRepair: the caller sent the explicit base-repair signal. */
  repair: boolean;
  log: (type: EventKind, msg: string) => void;
}

/** True when a repair run may enter PLAN on this verdict: a confirmed red base, never an unverified one. */
export function baseRepairMayProceed(health: BaseHealthResult): boolean {
  return health.kind === 'red' && health.failingChecks.length > 0 && health.awaitingCi !== true;
}

/** The base_repair_proceeding line: the failing checks and evidence a repair run starts from. */
export function baseRepairProceedingMessage(health: BaseHealthResult, ref: string, workKey: string | number): string {
  const evidence = describeBaseHealthEvidence(health.evidence ?? []);
  return (
    `${ref} ${(health.baseSha ?? '').slice(0, 8)} fails ${health.failingChecks.join(', ')} before PLAN` +
    `${evidence ? ` — ${evidence}` : ''} — base repair requested (FACTORY_BASE_HEALTH_REPAIR=1): #${workKey} proceeds to PLAN;` +
    ' CHECK still compares against the base baseline'
  );
}

/** The released outcome for a red or inconclusive base, or undefined when the run continues to PLAN. */
export function baseHealthGate(
  health: BaseHealthResult | undefined,
  opts: BaseHealthGateOptions,
): RunOutcome | undefined {
  if (health === undefined || health.baseSha === undefined) return undefined;
  if (health.kind !== 'red' && health.kind !== 'inconclusive') return undefined;
  if (opts.repair && baseRepairMayProceed(health)) {
    opts.log('base_repair_proceeding', baseRepairProceedingMessage(health, opts.ref, opts.workKey));
    return undefined;
  }
  opts.log('environment-released', baseHealthReleasedMessage(health, opts.ref, opts.workKey));
  return {
    state: 'released',
    reason: 'environment',
    branch: opts.branch,
    reworkRounds: 0,
    baseSha: health.baseSha,
    failingChecks: health.failingChecks,
    ...(health.awaitingCi ? { awaitingCi: true } : {}),
    ...(health.confirmedLocally ? { confirmedLocally: true } : {}),
    ...(health.evidence?.length ? { baseEvidence: health.evidence } : {}),
    ...(health.kind === 'inconclusive' ? { baseInconclusive: true as const } : {}),
  };
}
