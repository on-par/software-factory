import { issueNumberOf, type WorkKey } from '../work/work-key.js';
import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { type SlicePlan, withSlicesAffected } from '../readiness/slice-plan.js';
import { upsertSlicePlanComment } from '../readiness/slice-plan-github.js';
import type { RunOutcome } from '../run/outcome.js';

export interface LowerSliceChange {
  index: number;
  prNumber: number;
  recordedSha: string;
  currentSha: string;
}

export type LowerSliceChangeDetection =
  { status: 'changed'; change: LowerSliceChange } | { status: 'unchanged' } | { status: 'error'; detail: string };

export interface ReviewChangeParkResult {
  outcome: Extract<RunOutcome, { state: 'parked' }>;
  message: string;
  change: LowerSliceChange;
  affected: number[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function detectLowerSliceChange(opts: {
  octokit: Octokit;
  repo: string;
  plan: SlicePlan;
  log: (type: EventKind, msg: string) => void;
}): Promise<LowerSliceChangeDetection> {
  const { octokit, repo, plan, log } = opts;
  const [owner, repoName] = repo.split('/') as [string, string];
  const n = plan.slices.length;
  for (const slice of plan.slices) {
    if (slice.index >= n) break;
    if (slice.state !== 'pr-open' || slice.prNumber === undefined) continue;
    const label = `slice ${slice.index}/${n} PR #${slice.prNumber}`;
    if (slice.headSha === undefined) {
      log('ship', `${label} has no recorded head SHA; cannot detect review changes`);
      continue;
    }
    if (plan.slices.some((s) => s.index < slice.index && s.state === 'merged')) {
      log('ship', `${label} sits above a merged slice (GitHub may have rebased it); skipping the review-change check`);
      continue;
    }
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: slice.prNumber });
      if (data.state !== 'open') continue;
      if (data.head.sha !== slice.headSha) {
        return {
          status: 'changed',
          change: {
            index: slice.index,
            prNumber: slice.prNumber,
            recordedSha: slice.headSha,
            currentSha: data.head.sha,
          },
        };
      }
    } catch (err) {
      const detail = `could not read ${label} to check for review changes: ${messageOf(err)}`;
      log('ship', detail);
      return { status: 'error', detail };
    }
  }
  return { status: 'unchanged' };
}

export async function parkOnLowerSliceChange(opts: {
  octokit: Octokit;
  repo: string;
  issue: WorkKey;
  plan: SlicePlan;
  log: (type: EventKind, msg: string) => void;
}): Promise<ReviewChangeParkResult | undefined> {
  const { octokit, repo, issue, plan, log } = opts;
  const detection = await detectLowerSliceChange({ octokit, repo, plan, log });
  if (detection.status !== 'changed') return undefined;
  const { change } = detection;
  const n = plan.slices.length;
  const { plan: next, affected } = withSlicesAffected(plan, change.index);

  const layers = affected.length > 0 ? `slices ${affected.join(', ')} may no longer fit` : 'no open upper slices';
  const message =
    `review changes to slice ${change.index}/${n} PR #${change.prNumber} ` +
    `(head ${change.recordedSha.slice(0, 7)} → ${change.currentSha.slice(0, 7)}); ${layers} — parked; ` +
    'upper slices are not rebuilt automatically';
  log('escalate', message);

  try {
    await upsertSlicePlanComment({ octokit, repo, issue: issueNumberOf(issue), plan: next });
  } catch (err) {
    log('ship', `could not record the affected slices in the slice plan comment: ${messageOf(err)}`);
  }
  return { outcome: { state: 'parked', reason: 'escalate', prNumber: change.prNumber }, message, change, affected };
}
