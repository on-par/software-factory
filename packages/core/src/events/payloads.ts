// src/events/payloads.ts — structured payloads carried by specific EventKinds, split from kinds.ts

import type { ParkReason } from '../run/outcome.js';
import type { StuckTrigger } from '../steward/detect.js';

/** Payload of a park event (#3511): why the issue parked, what a human must do, and what waits behind it. */
export interface ParkPayload {
  reason: ParkReason;
  /** parkUnblockHint(reason, issue): the same text as the park comment's "What unblocks this" line. */
  decision: string;
  /** Lane the issue parked on; '' when the run had no lane. */
  lane: string;
  /** Issue numbers still queued behind the parked issue on this lane, in order. */
  blockedBehind: number[];
}

/** Payload of a `lane-paused` event. Two triggers: the lane circuit breaker
 *  (#1906/#1916) stopped `lane` after `firstIssue` and then `secondIssue` parked in
 *  a row with the same non-empty failure `signature`; or CHECK found every failing
 *  checker also failing on the base (#1928, `cause: 'environment'`), where
 *  `firstIssue === secondIssue` and `signature` is the CHECK failure signature
 *  (`''` when missing). */
export interface LanePausedPayload {
  lane: string;
  /** `failureSignature()` shared by both parks. */
  signature: string;
  /** Checker names that failed in both parks (e.g. ['tests','lint']). */
  failingChecks: string[];
  firstIssue: number;
  secondIssue: number;
  /** Absent for the signature breaker (#1928). */
  cause?: 'environment';
  /** Base SHA the failing checkers also failed on; set when `cause` is 'environment'. */
  baseSha?: string;
}

/** Payload of a `steward-triggered` event (#2084): `detectStuck` classified a parked run as
 *  stuck per ADR-0155. Emitted after the run's own park event and before the park's reports, so it is not itself a park. */
export interface StewardTriggeredPayload {
  /** Which ADR-0155 trigger matched. */
  trigger: StuckTrigger;
  /** The run's CHECK failure signature, when the outcome carries one. */
  failureSignature?: string;
}

/** Payload of a `flaky_tests` event (#2302): CHECK's serial re-run of the base-red tests checker. */
export interface FlakyTestsPayload {
  /** Base SHA the tests checker also failed on. */
  sha: string;
  checker: 'tests';
  mode: 'targeted' | 'full';
  /** Re-run test names; [] for a full re-run. */
  tests: string[];
  verdict: 'passed' | 'reproduced';
  /** Full-output log of the re-run, when written. */
  logPath?: string;
}

/** Payload of a `provider_auth_rejected` event (#3232): a provider rejected its credential and its breaker opened
 *  until the credentials change. `detail` passes through `redactText`, so it carries no key material. */
export interface ProviderAuthRejectedPayload {
  provider: string;
  harness?: string;
  model?: string;
  stage: 'plan' | 'build';
  issue: number;
  at: string;
  detail: string;
}

/** Payload of a `provider_breaker_close` event when a breaker closes other than by cooldown (#3232). */
export interface ProviderBreakerClosePayload {
  provider: string;
  cause: 'cooldown' | 'creds_changed' | 'manual_reset';
}

/** The provider-breaker payload fields an event record may carry. */
export interface ProviderEventExtra {
  providerCapped?: ProviderCappedPayload;
  providerAuthRejected?: ProviderAuthRejectedPayload;
  providerBreakerClose?: ProviderBreakerClosePayload;
}

/** The provider-breaker fields present on `extra`, so each sink copies them in one place. */
export function pickProviderEvent(extra?: ProviderEventExtra): ProviderEventExtra {
  return {
    ...(extra?.providerCapped ? { providerCapped: extra.providerCapped } : {}),
    ...(extra?.providerAuthRejected ? { providerAuthRejected: extra.providerAuthRejected } : {}),
    ...(extra?.providerBreakerClose ? { providerBreakerClose: extra.providerBreakerClose } : {}),
  };
}

/** Payload of a `provider_capped` event (#3337): a usage cap opened the provider's breaker until `cappedUntil`. */
export interface ProviderCappedPayload {
  provider: string;
  stage: 'plan' | 'build';
  issue: number;
  /** ISO instant the breaker holds the provider until. */
  cappedUntil: string;
  /** 'reported' when the provider gave a reset time; 'default-1h' when it did not and the provider is re-probed after 1 hour. */
  source: 'reported' | 'default-1h';
  /** Provider error detail, passed through redactSecrets. */
  detail: string;
}
