// #3126
import { describe, expect, it } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { CostEntry, FactoryEvent } from '../types/index.js';
import { agentInvocationsFromEvents, computeTokenCoverage } from './token-coverage.js';

const harnessOf = (model: string): string => (model.startsWith('claude') ? 'claude-cli' : 'codex');

function ev(type: FactoryEvent['type'], msg: string): FactoryEvent {
  return { ts: '2026-01-01T00:00:00.000Z', type, issue: '1', msg };
}
const phase = (name: string): FactoryEvent => ev('phase_started', `${name} started`);
const trying = (model: string, task: string): FactoryEvent => ev('router', `Trying ${model} for ${task} (attempt 1)`);

function row(task: string, model = 'claude-x', extra: Partial<CostEntry> = {}): CostEntry {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    issue: '1',
    task,
    model,
    inputTokens: 1,
    outputTokens: 1,
    cost: 0,
    ...extra,
  };
}

const EVENTS: FactoryEvent[] = [
  phase('plan'),
  trying('claude-x', 'plan'),
  phase('build'),
  trying('gpt-a', 'build_codex'),
  ev('router', 'gpt-a failed (rate_limit) on build_codex'),
  trying('claude-x', 'build_claude'),
  phase('check'),
  trying('claude-x', 'check_design'),
  trying('claude-x', 'build_claude'),
  phase('ship'),
  trying('claude-x', 'classify_pr'),
];

const ROWS: CostEntry[] = [
  row('plan'),
  row('build_claude'),
  row('check_design'),
  row('build_claude', 'claude-x', { retryCause: 'checker' }),
  row('classify_pr'),
];

describe('token coverage', () => {
  it('returns coverage 1 for every phase of a full PLAN→BUILD→CHECK→REVIEW→SHIP fixture run', () => {
    const invocations = agentInvocationsFromEvents(EVENTS, harnessOf);
    const cov = computeTokenCoverage(invocations, ROWS, harnessOf);
    expect(cov.phases.map((p) => p.key)).toEqual(['build', 'check', 'plan', 'ship']);
    for (const p of cov.phases) expect(p.coverage).toBe(1);
    for (const h of cov.harnesses) expect(h.coverage).toBe(1);
    expect(cov.gaps).toEqual([]);
    expect(cov.unattributedRows).toBe(0);
  });

  it('names a phase with invocations but no cost rows in gaps', () => {
    const invocations = agentInvocationsFromEvents(EVENTS, harnessOf);
    const cov = computeTokenCoverage(
      invocations,
      ROWS.filter((r) => r.task !== 'classify_pr'),
      harnessOf,
    );
    expect(cov.phases.find((p) => p.key === 'ship')?.coverage).toBe(0);
    expect(cov.gaps).toEqual(['ship']);
  });

  it('reports null coverage for a phase with no invocations', () => {
    const cov = computeTokenCoverage([], [row('steward', 'gpt-a')], harnessOf);
    expect(cov.phases).toEqual([{ key: 'ship', invocations: 0, rows: 1, coverage: null }]);
    expect(cov.harnesses).toEqual([{ key: 'codex', invocations: 0, rows: 1, coverage: null }]);
    expect(cov.gaps).toEqual([]);
    expect(computeTokenCoverage([], [], harnessOf).phases).toEqual([]);
  });

  it('counts rows with an unknown task as unattributed but keeps them in the harness total', () => {
    const cov = computeTokenCoverage([], [row('foo'), row('')], harnessOf);
    expect(cov.unattributedRows).toBe(2);
    expect(cov.phases).toEqual([]);
    expect(cov.harnesses[0]?.rows).toBe(2);
  });

  it('does not double-subtract the non-retryable failure line or count unrelated router text', () => {
    const invocations = agentInvocationsFromEvents(
      [
        phase('build'),
        trying('m1', 'build_claude'),
        trying('m2', 'build_claude'),
        ev('router', 'm2 failed (error) on build_claude'),
        ev('router', 'm2 failed (error) on build_claude — non-retryable, not failing over'),
        ev('router', 'Rate limited — cooldown'),
        ev('phase_started', 'garbled'),
      ],
      harnessOf,
    );
    expect(invocations.map((i) => i.model)).toEqual(['m1']);
    expect(invocations[0]?.phase).toBe('build');
  });

  it('falls back to phaseOfTask before any phase_started, then to unknown', () => {
    const invocations = agentInvocationsFromEvents([trying('m', 'classify_pr'), trying('m', 'mystery')], harnessOf);
    expect(invocations.map((i) => i.phase)).toEqual(['ship', 'unknown']);
  });

  it('pins router log format against a real ModelRouter', async () => {
    const models: ModelsConfig = {
      version: 1,
      models: {
        'stub-model': {
          provider: 'custom',
          tier: 'boss',
          costPerMtokInput: 0,
          costPerMtokOutput: 0,
          contextWindow: 1000,
          capabilities: [],
          envKey: null,
        },
      },
      tiers: { boss: ['stub-model'] },
      failover: {
        triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
        maxRetries: 2,
        cooldownMs: 0,
        escalateAfterTierExhausted: true,
      },
      routingRules: {},
    };
    const routes: RoutesConfig = { version: 1, routes: { plan: { tier: 'boss', description: 'stub' } } };
    const router = new ModelRouter(
      models,
      routes,
      false,
      new StubModelExecutor({ scripts: { plan: [{ output: 'ok' }] } }),
    );
    const lines: string[] = [];
    await router.run('plan', 'p', { onLog: (m) => lines.push(m) });
    const invocations = agentInvocationsFromEvents([phase('plan'), ...lines.map((m) => ev('router', m))], harnessOf);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ task: 'plan', model: 'stub-model', phase: 'plan' });
  });
});
