import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  runSimulation,
  simCommitAll,
  simSpecContent,
  type SimJitterConfig,
  type SimPipelineEvent,
  type SimulationReport,
  type SimWorkspace,
} from './index.js';
import { createSimWorkspace } from './workspace.js';

const NON_SLEEPING_CLOCK = { sleep: async () => {}, random: () => 0.5 };

describe('runSimulation', () => {
  let sharedWorkspace: SimWorkspace;
  let cleanReport: SimulationReport;

  beforeAll(async () => {
    sharedWorkspace = await createSimWorkspace();
    cleanReport = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        { issue: 9001, title: 'Sim clean issue one' },
        { issue: 9002, title: 'Sim clean issue two' },
        { issue: 9003, title: 'Sim clean issue three' },
      ],
    });
  }, 180_000);

  afterAll(() => sharedWorkspace.dispose());

  it('clean batch of N ships', { timeout: 180_000 }, () => {
    expect(cleanReport.totals).toEqual({ shipped: 3, parked: 0, escalated: 0 });
    for (const outcome of cleanReport.outcomes) {
      expect(outcome.state).toBe('shipped');
      expect(outcome.phase).toBe('ship');
      expect(outcome.prNumber).toBeDefined();
      expect(outcome.reworkRounds).toBe(0);
      expect(outcome.reason).toBeUndefined();
    }
  });

  it('makes no real model or GitHub calls — only fake calls against a local git remote', () => {
    expect(cleanReport.modelCalls).toBeGreaterThan(0);
    for (const outcome of cleanReport.outcomes) {
      for (const call of outcome.modelCalls) {
        expect(call.model).toBe('stub-model');
        expect(['plan', 'build_claude']).toContain(call.task);
      }
      for (const [name] of outcome.githubCalls) {
        expect(['issues.get', 'pulls.list', 'pulls.create', 'pulls.get', 'graphql']).toContain(name);
      }
    }
    const summedGithubCalls = cleanReport.outcomes.reduce((sum, o) => sum + o.githubCalls.length, 0);
    expect(cleanReport.githubCalls).toBe(summedGithubCalls);
    expect(sharedWorkspace.origin.startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  it('PLAN escalation maps to escalated', { timeout: 180_000 }, async () => {
    const report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        {
          issue: 9010,
          title: 'Sim plan escalation',
          scripts: { plan: [{ output: 'ESCALATE: needs a product decision' }] },
        },
      ],
    });
    const [outcome] = report.outcomes;
    expect(outcome.state).toBe('escalated');
    expect(outcome.phase).toBe('plan');
    expect(outcome.reason).toContain('needs a product decision');
  });

  it('BUILD escalation maps to escalated', { timeout: 180_000 }, async () => {
    const issue = 9011;
    const title = 'Sim build escalation';
    const report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        {
          issue,
          title,
          scripts: {
            plan: [{ output: simSpecContent(issue, title) }],
            build_claude: [{ output: 'ESCALATE: cannot proceed' }],
          },
        },
      ],
    });
    const [outcome] = report.outcomes;
    expect(outcome.state).toBe('escalated');
    expect(outcome.phase).toBe('build');
  });

  it('CHECK failure without rework maps to parked', { timeout: 180_000 }, async () => {
    const issue = 9012;
    const title = 'Sim check failure without rework';
    const report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        {
          issue,
          title,
          autoRework: false,
          scripts: {
            plan: [{ output: simSpecContent(issue, title) }],
            build_claude: [
              {
                output: 'built with failing verify',
                effect: async (ctx) => {
                  await mkdir(join(ctx.worktree, 'scripts'), { recursive: true });
                  await writeFile(join(ctx.worktree, 'scripts', 'verify.sh'), '#!/bin/bash\necho "boom" >&2\nexit 1\n');
                  await simCommitAll(ctx.worktree, 'feat: sim work with failing verify');
                },
              },
            ],
          },
        },
      ],
    });
    const [outcome] = report.outcomes;
    expect(outcome.state).toBe('parked');
    expect(outcome.phase).toBe('check');
  });

  it('CHECK stuck across rework rounds maps to escalated', { timeout: 180_000 }, async () => {
    const issue = 9013;
    const title = 'Sim check stuck across rework';
    const report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        {
          issue,
          title,
          autoRework: true,
          scripts: {
            plan: [{ output: simSpecContent(issue, title) }],
            build_claude: [
              {
                output: 'built with failing verify',
                effect: async (ctx) => {
                  await mkdir(join(ctx.worktree, 'scripts'), { recursive: true });
                  await writeFile(join(ctx.worktree, 'scripts', 'verify.sh'), '#!/bin/bash\necho "boom" >&2\nexit 1\n');
                  await simCommitAll(ctx.worktree, 'feat: sim work with failing verify');
                },
              },
              // No further build_claude steps — the executor's defaultStep ({ output: '' },
              // no effect) never repairs scripts/verify.sh, so the failure signature repeats
              // and CHECK's rework loop declares the lane stuck.
            ],
          },
        },
      ],
    });
    const [outcome] = report.outcomes;
    expect(outcome.state).toBe('escalated');
    expect(outcome.phase).toBe('check');
    expect(outcome.reworkRounds).toBeGreaterThan(0);
  });

  it('SHIP failure maps to parked', { timeout: 180_000 }, async () => {
    const issue = 9014;
    const title = 'Sim ship failure';
    const report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        {
          issue,
          title,
          endpoints: { 'pulls.create': [{ fail: 'sim: pulls.create refused' }] },
        },
      ],
    });
    const [outcome] = report.outcomes;
    expect(outcome.state).toBe('parked');
    expect(outcome.phase).toBe('ship');
    expect(outcome.reason).toContain('pulls.create refused');
  });

  it('streams events via onEvent and collects them on the outcome', { timeout: 180_000 }, async () => {
    const issue = 9015;
    const title = 'Sim events streaming';
    const streamed: SimPipelineEvent[] = [];
    const report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [{ issue, title }],
      onEvent: (forIssue, event) => {
        expect(forIssue).toBe(issue);
        streamed.push(event);
      },
    });
    const [outcome] = report.outcomes;
    expect(outcome.events.some((e) => e.phase === 'plan')).toBe(true);
    expect(streamed.length).toBeGreaterThanOrEqual(outcome.events.length);
  });

  it('a workspace created for a caller-supplied run is left alone', { timeout: 180_000 }, async () => {
    const ws = await createSimWorkspace();
    expect(existsSync(ws.origin)).toBe(true);
    await ws.dispose();
    expect(existsSync(ws.origin)).toBe(false);
  });

  it(
    'an owned workspace (no workspace option) is created and disposed automatically',
    { timeout: 180_000 },
    async () => {
      const report = await runSimulation({
        issues: [{ issue: 9016, title: 'Sim owned workspace' }],
      });
      expect(report.totals.shipped).toBe(1);
    },
  );

  it('deterministic jitter replays the identical delay/failure sequence (AC1)', { timeout: 180_000 }, async () => {
    const jitter: SimJitterConfig = {
      seed: 20260804,
      phases: {
        plan: { delay: { minMs: 5, maxMs: 40 }, failureRate: 0.4 },
        build: { delay: { minMs: 5, maxMs: 40 }, failureRate: 0.4 },
        check: { failureRate: 0.2 },
        ship: { failureRate: 0.2 },
      },
    };
    const issues = [{ issue: 9020, title: 'Sim deterministic jitter' }];

    const wsA = await createSimWorkspace();
    const runA = await runSimulation({ workspace: wsA, issues, jitter, clock: NON_SLEEPING_CLOCK });
    await wsA.dispose();

    const wsB = await createSimWorkspace();
    const runB = await runSimulation({ workspace: wsB, issues, jitter, clock: NON_SLEEPING_CLOCK });
    await wsB.dispose();

    expect(runA.outcomes[0]?.jitterDraws).toEqual(runB.outcomes[0]?.jitterDraws);
    expect(runA.outcomes[0]?.jitterDraws.length).toBeGreaterThan(0);
    expect(runA.outcomes[0]?.jitterDraws.some((d) => d.failure !== null)).toBe(true);
    expect(runA.outcomes[0]?.state).toBe(runB.outcomes[0]?.state);
    expect(runA.outcomes[0]?.phase).toBe(runB.outcomes[0]?.phase);
    expect(runA.outcomes[0]?.reworkRounds).toBe(runB.outcomes[0]?.reworkRounds);
  });

  it('100% BUILD failure parks or escalates every issue (AC2)', { timeout: 180_000 }, async () => {
    const jitter: SimJitterConfig = { seed: 4242, phases: { build: { failureRate: 1 } } };
    const ws = await createSimWorkspace();
    const report = await runSimulation({
      workspace: ws,
      issues: [
        { issue: 9021, title: 'Sim 100pct build failure one' },
        { issue: 9022, title: 'Sim 100pct build failure two' },
      ],
      jitter,
      clock: NON_SLEEPING_CLOCK,
    });
    await ws.dispose();

    expect(report.totals.shipped).toBe(0);
    for (const outcome of report.outcomes) {
      expect(['parked', 'escalated']).toContain(outcome.state);
      expect(outcome.prNumber).toBeUndefined();
    }
    expect(report.injectedFailures).toBeGreaterThan(0);
  });

  it('zero jitter matches the clean-path baseline (AC3)', { timeout: 180_000 }, async () => {
    const ws = await createSimWorkspace();
    const report = await runSimulation({
      workspace: ws,
      issues: [
        { issue: 9001, title: 'Sim clean issue one' },
        { issue: 9002, title: 'Sim clean issue two' },
        { issue: 9003, title: 'Sim clean issue three' },
      ],
      jitter: { seed: 99, default: { failureRate: 0, delay: 0 } },
      clock: NON_SLEEPING_CLOCK,
    });
    await ws.dispose();

    expect(report.totals).toEqual(cleanReport.totals);
    report.outcomes.forEach((outcome, i) => {
      const clean = cleanReport.outcomes[i];
      expect({
        state: outcome.state,
        phase: outcome.phase,
        route: outcome.route,
        reworkRounds: outcome.reworkRounds,
      }).toEqual({ state: clean?.state, phase: clean?.phase, route: clean?.route, reworkRounds: clean?.reworkRounds });
      expect(outcome.prNumber).toBeDefined();
    });
    expect(report.injectedFailures).toBe(0);
    expect(report.outcomes[0]?.jitterDraws.length).toBeGreaterThan(0);
  });
});
