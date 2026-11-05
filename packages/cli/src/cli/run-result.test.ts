// packages/cli/src/cli/run-result.test.ts — the `--json` run result: outcome classification, phases, cost (#3907)
import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { CostEntry, FactoryEvent, RunOutcome } from '@on-par/factory-core';

import type { MergeResult } from './run-issue-merge.js';
import { runResultJsonSchema } from './json-contract.js';
import { buildRunResult, classifyRunOutcome, type RunResultInput } from './run-result.js';

const route = 'claude' as const;
const T0 = '2026-01-01T00:00:00.000Z';
const T9 = '2026-01-01T01:00:00.000Z';

const ev = (type: FactoryEvent['type'], ts: string, extra: Partial<FactoryEvent> = {}): FactoryEvent => ({
  ts,
  type,
  issue: '5',
  msg: 'm',
  ...extra,
});
const cost = (ts: string, model: string, usd: number | null, issue = '5'): CostEntry => ({
  ts,
  issue,
  task: 't',
  model,
  inputTokens: 1,
  outputTokens: 1,
  cost: usd,
});

const input = (over: Partial<RunResultInput> = {}): RunResultInput => ({
  issue: 5,
  repo: 'acme/widgets',
  outcome: undefined,
  merge: undefined,
  error: undefined,
  startedAt: T0,
  finishedAt: T9,
  branch: undefined,
  baseSha: null,
  headSha: null,
  events: [],
  costs: [],
  ...over,
});

describe('classifyRunOutcome', () => {
  const shipped: RunOutcome = { state: 'shipped', route, branch: 'b', reworkRounds: 0, prNumber: 7 };

  it('maps merge results to merged, held and ci-failed, plus timed-out and land-failed', () => {
    const c = (merge: MergeResult) => classifyRunOutcome(shipped, merge, undefined);
    expect(c({ kind: 'merged', detail: 'x' })).toEqual({ outcome: 'merged', exitReason: 'merged' });
    expect(c({ kind: 'held', gate: 'risk', detail: 'high' })).toEqual({
      outcome: 'held',
      exitReason: 'held by risk: high',
    });
    expect(c({ kind: 'ci-failed', detail: 'red' })).toEqual({ outcome: 'ci-failed', exitReason: 'red' });
    expect(c({ kind: 'timed-out', detail: '30m' })).toEqual({
      outcome: 'pr-open',
      exitReason: 'merge timed out: 30m',
    });
    expect(c({ kind: 'land-failed', detail: 'conflict' })).toEqual({
      outcome: 'failed',
      exitReason: 'land failed: conflict',
    });
    expect(c({ kind: 'failed-before-pr', detail: 'x' }).outcome).toBe('pr-open');
  });

  it('a land-deferred merge result maps to outcome land-deferred with landDeferrals', () => {
    const merge: MergeResult = { kind: 'land-deferred', prNumber: 7, deferrals: 3, detail: 'base kept moving' };
    expect(classifyRunOutcome(shipped, merge, undefined)).toEqual({
      outcome: 'land-deferred',
      exitReason: 'land deferred 3 time(s): base kept moving',
    });
    const r = buildRunResult(input({ outcome: shipped, merge }));
    expect(r.outcome).toBe('land-deferred');
    expect(r.landDeferrals).toBe(3);
    expect(runResultJsonSchema.parse(r)).toEqual(r);
    expect(buildRunResult(input({ outcome: shipped })).landDeferrals).toBeUndefined();
  });

  it('maps run outcomes without --merge', () => {
    const c = (o: RunOutcome | undefined, e?: unknown) => classifyRunOutcome(o, undefined, e);
    const ready = { state: 'ready', route, branch: 'b', reworkRounds: 0 } as const;
    expect(c(shipped)).toEqual({ outcome: 'pr-open', exitReason: 'PR #7 opened' });
    expect(c({ ...ready, prNumber: 8, draft: true }).exitReason).toBe('PR #8 opened (draft)');
    expect(c(ready)).toEqual({ outcome: 'held', exitReason: 'stopped before SHIP: no PR opened' });
    for (const reason of ['ci-failed', 'ci-infra', 'ci-never-started'] as const) {
      expect(c({ state: 'parked', reason }).outcome).toBe('ci-failed');
    }
    expect(c({ state: 'parked', reason: 'held' }).outcome).toBe('held');
    expect(c({ state: 'parked', reason: 'fail' }, new Error('boom'))).toEqual({
      outcome: 'parked',
      exitReason: 'parked: fail: boom',
    });
    expect(c({ state: 'escalated', reason: 'unclear' })).toEqual({ outcome: 'parked', exitReason: 'parked: unclear' });
    expect(c({ state: 'released', reason: 'provider-cap', reworkRounds: 0, providers: [], resetAt: T9 })).toEqual({
      outcome: 'failed',
      exitReason: 'released: provider-cap',
    });
    expect(c(undefined, new Error('skipped: closed'))).toEqual({ outcome: 'failed', exitReason: 'skipped: closed' });
    expect(c(undefined)).toEqual({ outcome: 'failed', exitReason: 'the run produced no outcome' });
  });
});

describe('buildRunResult', () => {
  it('groups phases by name with timings, attempts and the model in the window', () => {
    const r = buildRunResult(
      input({
        events: [
          ev('phase_started', '2026-01-01T00:01:00.000Z', { phase: 'plan' }),
          ev('phase_completed', '2026-01-01T00:02:00.000Z', { phase: 'plan' }),
          ev('phase_started', '2026-01-01T00:03:00.000Z', { phase: 'build' }),
          ev('phase_completed', '2026-01-01T00:04:00.000Z', { phase: 'build' }),
          ev('phase_started', '2026-01-01T00:05:00.000Z', { phase: 'build' }),
          ev('phase_started', '2026-01-01T00:06:00.000Z', { msg: 'check starting' }),
          ev('phase_started', '2025-12-31T00:00:00.000Z', { phase: 'old' }),
          { ...ev('phase_started', '2026-01-01T00:07:00.000Z', { phase: 'other' }), issue: '6' },
        ],
        costs: [cost('2026-01-01T00:01:30.000Z', 'plan-model', 1), cost('2026-01-01T00:03:30.000Z', 'build-model', 1)],
      }),
    );
    expect(r.phases.map((p) => p.name)).toEqual(['plan', 'build', 'check']);
    expect(r.phases[0]).toEqual({
      name: 'plan',
      startedAt: '2026-01-01T00:01:00.000Z',
      finishedAt: '2026-01-01T00:02:00.000Z',
      model: 'plan-model',
      attempts: 1,
    });
    expect(r.phases[1]).toMatchObject({ attempts: 2, finishedAt: '2026-01-01T00:04:00.000Z', model: 'build-model' });
    expect(r.phases[2]).toMatchObject({ finishedAt: null, attempts: 1 });
  });

  it('sums cost and byModel, ignoring null cost rows, other issues and earlier rows', () => {
    const r = buildRunResult(
      input({
        costs: [
          cost('2026-01-01T00:01:00.000Z', 'a', 0.1),
          cost('2026-01-01T00:02:00.000Z', 'a', 0.2),
          cost('2026-01-01T00:03:00.000Z', 'b', null),
          cost('2026-01-01T00:04:00.000Z', 'a', 9, '6'),
          cost('2025-12-31T00:00:00.000Z', 'a', 9),
        ],
      }),
    );
    expect(r.cost).toEqual({ usd: 0.3, byModel: { a: 0.3, b: 0 } });
  });

  it('fills pr, branch and rework from the outcome and merge result', () => {
    const outcome: RunOutcome = {
      state: 'ready',
      route,
      branch: 'factory/5',
      reworkRounds: 2,
      prNumber: 7,
      draft: true,
    };
    expect(buildRunResult(input({ outcome })).pr).toEqual({
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      state: 'draft',
    });
    const merged = buildRunResult(input({ outcome, merge: { kind: 'merged', prNumber: 7, detail: '' } }));
    expect(merged).toMatchObject({ outcome: 'merged', branch: 'factory/5', reworkRounds: 2 });
    expect(merged.pr?.state).toBe('merged');
    expect(buildRunResult(input({ repo: null, outcome })).pr?.url).toBeNull();
    expect(buildRunResult(input({ branch: 'fallback' })).branch).toBe('fallback');
    expect(buildRunResult(input()).pr).toBeNull();
  });

  it('fixture for each outcome validates against run-result.schema.json', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../schemas/run-result.schema.json', import.meta.url), 'utf-8'),
    ) as object;
    const validate = new Ajv2020().compile(schema);
    const shipped: RunOutcome = { state: 'shipped', route, branch: 'b', reworkRounds: 0, prNumber: 7 };
    const fixtures: RunResultInput[] = [
      input({ outcome: shipped, merge: { kind: 'merged', prNumber: 7, detail: '' } }),
      input({ outcome: shipped }),
      input({ outcome: shipped, merge: { kind: 'held', gate: 'risk', detail: 'x' } }),
      input({ outcome: { state: 'parked', reason: 'ci-failed' } }),
      input({ outcome: { state: 'parked', reason: 'fail' } }),
      input({ error: new Error('boom') }),
    ];
    const outcomes = fixtures.map((f) => {
      const r = buildRunResult(f);
      expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
      return r.outcome;
    });
    expect(outcomes).toEqual(['merged', 'pr-open', 'held', 'ci-failed', 'parked', 'failed']);
  });
});
