// packages/cli/src/cli/lane-pause.ts — the lane-paused event, base hold, and comment, moved out of run-lane.ts

import type { getFactoryPaths, LanePausedPayload } from '@on-par/factory-core';
import type { logEvent } from '@on-par/factory-core/internal';

import { BASE_HOLD_CI_RECHECK_MS, writeBaseHold } from './base-hold.js';
import type { LaneEnvironmentPauseError } from './lane-environment-pause-error.js';

type LanePauseContext = {
  lane: string;
  paths: ReturnType<typeof getFactoryPaths>;
  emitEvent: typeof logEvent;
};

export function renderLanePausedComment(payload: LanePausedPayload): string {
  const checks = payload.failingChecks.length
    ? payload.failingChecks.map((c) => `\`${c}\``).join(', ')
    : 'none recorded';
  return [
    `Lane '${payload.lane}' is paused: this issue and #${payload.firstIssue} parked with the same failure signature, so the factory stopped claiming issues on this lane.`,
    `Shared failing checks: ${checks}`,
    `To resume: fix the shared failure (often on the base branch), then re-run \`factory run\` to resume lane '${payload.lane}'.`,
    `Failure signature: \`${payload.signature}\``,
  ].join('\n\n');
}

/** Persists the base hold and emits the environment lane-paused event for a broken base (#1928). */
export function pauseLaneForBrokenBase(
  ctx: LanePauseContext,
  issue: number,
  err: LaneEnvironmentPauseError,
  ghRepo: string,
  now: () => Date,
): void {
  const { lane, paths, emitEvent } = ctx;
  // Persist the hold so a restarted supervisor remembers the broken base (#2348);
  // best-effort, never allowed to change lane flow.
  try {
    writeBaseHold(paths.baseHold, {
      repo: ghRepo,
      baseSha: err.baseSha,
      failingChecks: err.failingChecks,
      since: new Date().toISOString(),
      ...(err.awaitingCi ? { ciRecheckAfter: new Date(now().getTime() + BASE_HOLD_CI_RECHECK_MS).toISOString() } : {}),
      ...(err.confirmedLocally ? { confirmedLocally: true as const } : {}),
    });
  } catch {}
  const payload: LanePausedPayload = {
    lane,
    signature: err.failureSignature ?? '',
    failingChecks: err.failingChecks,
    firstIssue: issue,
    secondIssue: issue,
    cause: 'environment',
    baseSha: err.baseSha,
  };
  emitEvent(
    paths.events,
    'lane-paused',
    lane,
    `lane '${lane}' paused: #${issue} failed only on checkers that also fail on base ${err.baseSha.slice(0, 8)} (${err.failingChecks.join(', ')}); #${issue} released to queued`,
    { lane, lanePaused: payload },
  );
}

/** Emits the lane-breaker lane-paused event and posts the lane-paused comment (#1918, #1919). */
export async function tripLaneBreaker(
  ctx: LanePauseContext,
  streak: { signature: string; firstIssue: number; failingChecks: string[] },
  issue: number,
  checks: string[],
  commentIssue: (issue: number, body: string) => Promise<void>,
): Promise<void> {
  const { lane, paths, emitEvent } = ctx;
  const { signature: tripSignature, firstIssue, failingChecks: firstChecks } = streak;
  const payload: LanePausedPayload = {
    lane,
    signature: tripSignature,
    failingChecks: checks.filter((c) => firstChecks.includes(c)),
    firstIssue,
    secondIssue: issue,
  };
  emitEvent(
    paths.events,
    'lane-paused',
    lane,
    `lane '${lane}' paused: #${payload.firstIssue} and #${payload.secondIssue} parked with the same failure signature (${payload.failingChecks.join(', ') || 'no failing checks'})`,
    { lane, lanePaused: payload },
  );
  // Tell the developer on GitHub why the lane stopped (#1919); fail-closed, never changes lane flow.
  await commentIssue(payload.secondIssue, renderLanePausedComment(payload)).catch(() => {});
}
