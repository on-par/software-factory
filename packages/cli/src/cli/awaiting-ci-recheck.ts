// packages/cli/src/cli/awaiting-ci-recheck.ts — re-checks PRs left open because their CI never started (#3208)

import type { EventKind } from '@on-par/factory-core';
import {
  clearAwaitingCi,
  nextRecheckAt,
  readAwaitingCi,
  upsertAwaitingCi,
  type AwaitingCiRecord,
  type RequiredChecksState,
} from '@on-par/factory-core/internal';

export type AwaitingCiParkReason = 'ci-failed' | 'ci-never-started';

/** The lane's own park path and event sink, handed to the re-check so it parks exactly like a lane park. */
export interface AwaitingCiLaneOps {
  park(rec: AwaitingCiRecord, reason: AwaitingCiParkReason, message: string): Promise<void>;
  emit(kind: EventKind, issue: number, message: string): void;
}

export interface AwaitingCiRecheckDeps extends AwaitingCiLaneOps {
  file: string;
  now(): number;
  capMs: number;
  getPr(prNumber: number): Promise<{ state: 'open' | 'closed'; merged: boolean; headSha: string; baseRef: string }>;
  /** The verdict on the PR's current head; `total` is the number of check runs on it. */
  verdict(args: { headSha: string; baseRef: string }): Promise<RequiredChecksState & { total: number }>;
  /** Squash-merges pinned to `sha`, the head the verdict was computed on. */
  merge(rec: AwaitingCiRecord, sha: string): Promise<void>;
}

const HOUR_MS = 3_600_000;
const hoursSince = (from: number, to: number): number => Math.round(((to - from) / HOUR_MS) * 10) / 10;

/** Handles every awaiting-ci record that is due: merge on green, park on failure or past the cap, else reschedule. */
export async function recheckDueAwaitingCi(deps: AwaitingCiRecheckDeps): Promise<void> {
  const { file, now, capMs, getPr, verdict, merge, park, emit } = deps;
  const due = (await readAwaitingCi(file)).filter((rec) => rec.nextRecheckAt <= now());
  for (const rec of due) {
    const label = `PR #${rec.prNumber}`;
    const reschedule = async (headSha: string): Promise<void> => {
      const attempts = rec.attempts + 1;
      const next = nextRecheckAt(rec.firstSeenAt, attempts);
      await upsertAwaitingCi(file, { ...rec, headSha, attempts, nextRecheckAt: next });
      emit(
        'awaiting-ci',
        rec.issue,
        `${label} still awaiting CI on ${headSha}; next re-check at ${new Date(next).toISOString()}`,
      );
    };
    try {
      const pr = await getPr(rec.prNumber);
      if (pr.state === 'closed' || pr.merged) {
        await clearAwaitingCi(file, rec.issue);
        emit('awaiting-ci', rec.issue, `${label} is ${pr.merged ? 'merged' : 'closed'}; no longer awaiting CI`);
        continue;
      }
      const sha = pr.headSha;
      const v = await verdict({ headSha: sha, baseRef: pr.baseRef });
      if (v.state === 'green') {
        try {
          await merge(rec, sha);
        } catch (err) {
          emit(
            'warn',
            rec.issue,
            `${label} merge pinned to ${sha} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          await reschedule(sha);
          continue;
        }
        await clearAwaitingCi(file, rec.issue);
        emit('ship', rec.issue, `${label} CI went green on ${sha}; squash-merged pinned to that commit`);
      } else if (v.state === 'failed') {
        await park(rec, 'ci-failed', `CI failed for ${label} on ${sha}: ${v.failed.join(', ')} — refusing to merge`);
        await clearAwaitingCi(file, rec.issue);
      } else if (now() - rec.firstSeenAt >= capMs) {
        const hours = hoursSince(rec.firstSeenAt, now());
        if (v.total === 0) {
          await park(
            rec,
            'ci-never-started',
            `${label} head ${sha}: no CI run ever registered after ${hours} h — a CI or config problem, not a failing build`,
          );
        } else {
          await park(rec, 'ci-failed', `CI still pending after ${hours} h for ${label} on ${sha} — refusing to merge`);
        }
        await clearAwaitingCi(file, rec.issue);
      } else {
        await reschedule(sha);
      }
    } catch (err) {
      emit(
        'warn',
        rec.issue,
        `awaiting-ci re-check of ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
