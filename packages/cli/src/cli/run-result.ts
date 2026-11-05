// packages/cli/src/cli/run-result.ts — turn one run's outcome, merge result, events and costs into the `--json` run result (#3907)

import type { CostEntry, FactoryEvent, RunOutcome } from '@on-par/factory-core';

import type { RunResultJson, RunResultOutcome } from './json-contract.js';
import type { MergeResult } from './run-issue-merge.js';

const CI_PARKS: ReadonlySet<string> = new Set(['ci-failed', 'ci-infra', 'ci-never-started']);

/** The end state `factory run --issue` reached (#3908); it wins over the merge result and the ship outcome. */
export interface LifecycleResult {
  outcome: 'merged' | 'closed' | 'parked' | 'awaiting-review';
  prNumber?: number;
  detail: string;
}

export interface RunResultInput {
  issue: number;
  repo: string | null;
  outcome: RunOutcome | undefined;
  merge: MergeResult | undefined;
  lifecycle?: LifecycleResult | undefined;
  error: unknown;
  startedAt: string;
  finishedAt: string;
  branch: string | undefined;
  baseSha: string | null;
  headSha: string | null;
  events: FactoryEvent[];
  costs: CostEntry[];
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return error instanceof Error ? error.message : String(error);
}

function classifyMerge(merge: MergeResult): { outcome: RunResultOutcome; exitReason: string } | undefined {
  switch (merge.kind) {
    case 'merged':
      return { outcome: 'merged', exitReason: 'merged' };
    case 'held':
      return { outcome: 'held', exitReason: `held by ${merge.gate ?? 'gate'}: ${merge.detail}` };
    case 'ci-failed':
      return { outcome: 'ci-failed', exitReason: merge.detail || 'CI failed' };
    case 'timed-out':
      return { outcome: 'pr-open', exitReason: `merge timed out: ${merge.detail}` };
    case 'land-failed':
      return { outcome: 'failed', exitReason: `land failed: ${merge.detail}` };
    case 'land-deferred':
      return {
        outcome: 'land-deferred',
        exitReason: `land deferred ${merge.deferrals ?? 0} time(s): ${merge.detail}`,
      };
    case 'failed-before-pr':
      return undefined;
  }
}

/** Maps a run's outcome (and `--merge` result, which wins when present) to one of the six result outcomes plus a reason. */
export function classifyRunOutcome(
  outcome: RunOutcome | undefined,
  merge: MergeResult | undefined,
  error: unknown,
  lifecycle?: LifecycleResult,
): { outcome: RunResultOutcome; exitReason: string } {
  if (lifecycle) return { outcome: lifecycle.outcome, exitReason: lifecycle.detail || lifecycle.outcome };
  const merged = merge ? classifyMerge(merge) : undefined;
  if (merged) return merged;
  const message = errorMessage(error);
  if (!outcome) return { outcome: 'failed', exitReason: message ?? 'the run produced no outcome' };
  const withError = (reason: string) => (message ? `${reason}: ${message}` : reason);
  switch (outcome.state) {
    case 'shipped':
      return { outcome: 'pr-open', exitReason: `PR #${outcome.prNumber} opened` };
    case 'ready':
      if (outcome.prNumber === undefined) {
        return { outcome: 'held', exitReason: 'stopped before SHIP: no PR opened' };
      }
      return { outcome: 'pr-open', exitReason: `PR #${outcome.prNumber} opened${outcome.draft ? ' (draft)' : ''}` };
    case 'parked':
      if (CI_PARKS.has(outcome.reason))
        return { outcome: 'ci-failed', exitReason: withError(`parked: ${outcome.reason}`) };
      if (outcome.reason === 'held') return { outcome: 'held', exitReason: withError('parked: held') };
      return { outcome: 'parked', exitReason: withError(`parked: ${outcome.reason}`) };
    case 'escalated':
      return { outcome: 'parked', exitReason: withError(`parked: ${outcome.reason}`) };
    case 'released':
      return { outcome: 'failed', exitReason: `released: ${outcome.reason}` };
  }
}

function buildPhases(events: FactoryEvent[], costs: CostEntry[], finishedAt: string): RunResultJson['phases'] {
  const byName = new Map<string, { startedAt: string; finishedAt: string | null; attempts: number }>();
  for (const e of events) {
    if (e.type !== 'phase_started' && e.type !== 'phase_completed') continue;
    const name = e.phase ?? e.msg.trim().split(/\s+/)[0] ?? '';
    if (name === '') continue;
    let p = byName.get(name);
    if (e.type === 'phase_started') {
      if (!p) {
        p = { startedAt: e.ts, finishedAt: null, attempts: 0 };
        byName.set(name, p);
      }
      p.attempts += 1;
    } else if (p) {
      p.finishedAt = e.ts;
    }
  }
  return [...byName].map(([name, p]) => {
    const end = p.finishedAt ?? finishedAt;
    const inWindow = costs.filter((c) => c.ts >= p.startedAt && c.ts <= end);
    return { name, ...p, model: inWindow.at(-1)?.model ?? null };
  });
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Builds the schema-valid run result from what the run recorded; pure, no I/O. */
export function buildRunResult(input: RunResultInput): RunResultJson {
  const { outcome, merge, lifecycle, repo, startedAt } = input;
  const issueKey = String(input.issue);
  const events = input.events.filter((e) => e.issue === issueKey && e.ts >= startedAt);
  const costs = input.costs.filter((c) => c.issue === issueKey && c.ts >= startedAt);
  const prNumber =
    merge?.prNumber ?? lifecycle?.prNumber ?? (outcome && 'prNumber' in outcome ? outcome.prNumber : undefined);
  const prState =
    lifecycle?.outcome === 'closed'
      ? 'closed'
      : merge?.kind === 'merged' || lifecycle?.outcome === 'merged'
        ? 'merged'
        : outcome?.state === 'ready' && outcome.draft
          ? 'draft'
          : 'open';
  const byModel: Record<string, number> = {};
  let total = 0;
  for (const c of costs) {
    total += c.cost ?? 0;
    byModel[c.model] = (byModel[c.model] ?? 0) + (c.cost ?? 0);
  }
  for (const model of Object.keys(byModel)) byModel[model] = round6(byModel[model]);
  return {
    schemaVersion: 2,
    issue: input.issue,
    repo,
    ...classifyRunOutcome(outcome, merge, input.error, lifecycle),
    pr:
      prNumber === undefined
        ? null
        : { number: prNumber, url: repo ? `https://github.com/${repo}/pull/${prNumber}` : null, state: prState },
    branch: outcome?.branch ?? input.branch ?? null,
    baseSha: input.baseSha,
    headSha: input.headSha,
    startedAt,
    finishedAt: input.finishedAt,
    phases: buildPhases(events, costs, input.finishedAt),
    cost: { usd: round6(total), byModel },
    reworkRounds: outcome?.reworkRounds ?? 0,
    ...(merge?.kind === 'land-deferred' ? { landDeferrals: merge.deferrals ?? 0 } : {}),
  };
}
