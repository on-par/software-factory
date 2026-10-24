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
  cause?: 'environment' | 'provider-cap' | 'all_providers_down';
  /** Base SHA the failing checkers also failed on; set when `cause` is 'environment'. */
  baseSha?: string;
  /** Earliest provider reset (ISO) the lane waits for; set when `cause` is 'provider-cap' (#3226). */
  resetAt?: string;
  /** Capped providers of the blocked stage; set when `cause` is 'provider-cap' (#3226) or 'all_providers_down' (#3235, the breaker-open ones the lane watches). */
  providers?: string[];
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

/** Payload of a `provider_auth_rejected` event (#3232): a provider rejected a credential and its breaker is held until the credentials change. */
export interface ProviderAuthRejectedPayload {
  provider: string;
  harness: string;
  model: string;
  stage: 'plan' | 'build';
  issue: number;
  at: string;
  /** Provider error detail, passed through redactText. */
  detail: string;
}

/** Payload of a `provider_breaker_close` event (#3232): why the breaker closed. */
export interface ProviderBreakerClosePayload {
  provider: string;
  cause: 'cooldown' | 'creds_changed' | 'manual_reset';
}

/** Payload of a `provider_restored` event (#3236): a provider breaker closed, by any path. */
export interface ProviderRestoredPayload {
  provider: string;
  /** ISO instant of the close. */
  at: string;
  cause: 'creds_changed' | 'manual_reset' | 'timed_reset';
}

/** Payload of a `provider_refused` event (#3335): failover refuses a provider whose login is metered (`api`) or unproven (`unknown`). Never carries a credential value. */
export interface ProviderRefusedPayload {
  provider: string;
  login: 'api' | 'unknown';
  /** ISO instant of the refusal. */
  at: string;
}

/** Payload of an `all_providers_down` event (#3235): every provider of the stage is down and no reset time is known. */
export interface AllProvidersDownPayload {
  stage: 'plan' | 'build' | 'check';
  /** Each provider with its breaker reason (or 'metered'); `until` is an ISO instant, 'credentials-change', or null. */
  providers: { provider: string; reason: string; until: string | null }[];
  detail: 'untimed_breakers' | 'only_metered_left';
  /** Always null: no reset time is known, that is why the issue parked instead of re-queuing. */
  nextAvailableAt: string | null;
  issue: number;
  at: string;
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
