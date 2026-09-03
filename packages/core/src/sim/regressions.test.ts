// packages/core/src/sim/regressions.test.ts — proves the headless simulator reproduces the
// historical (still-open) signatures of #550 and #551 end to end through the real PLAN phase,
// and pins the fixed #1172 ship path (re-pinned by #1222) through the real SHIP phase.

import { DesignArtifactSchema } from '@on-par/contracts';
import matter from 'gray-matter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FACTORY_TASK_REQUIRED_FIELDS } from '../readiness/index.js';
import {
  runSimulation,
  SIM_REGRESSION_FIXTURES,
  simRegressionFixture,
  simSpecWithObjectInterface,
  type SimIssueOutcome,
  type SimulationReport,
  type SimWorkspace,
} from './index.js';
import { createSimWorkspace } from './workspace.js';

describe('sim regression fixtures (#567)', () => {
  let sharedWorkspace: SimWorkspace;
  let report: SimulationReport;
  let controlOutcome: SimIssueOutcome;
  let outcome550: SimIssueOutcome;
  let outcome551: SimIssueOutcome;
  let outcome1222: SimIssueOutcome;

  beforeAll(async () => {
    sharedWorkspace = await createSimWorkspace();
    report = await runSimulation({
      workspace: sharedWorkspace,
      issues: [
        { issue: 9552, title: 'Sim regression control' },
        simRegressionFixture(550).spec,
        simRegressionFixture(551).spec,
        simRegressionFixture(1222).spec,
      ],
    });
    [controlOutcome, outcome550, outcome551, outcome1222] = report.outcomes;
  }, 180_000);

  afterAll(() => sharedWorkspace.dispose());

  it('#550 fixed behaviour: retries fenced enrichment output and ships', { timeout: 180_000 }, () => {
    expect(outcome550.state).toBe('shipped');
    const enrichmentCalls = outcome550.modelCalls.filter((call) => call.task === 'readiness_enrich');
    expect(enrichmentCalls).toHaveLength(2);
    expect(enrichmentCalls[1].prompt).toContain('<untrusted-previous-output>');
    for (const field of FACTORY_TASK_REQUIRED_FIELDS) {
      expect(enrichmentCalls[1].prompt).toContain(field);
    }
    expect(outcome550.githubCalls.some(([name]) => name === 'issues.update')).toBe(true);
  });

  it('#551 silent design-artifact loss: designArtifact is null but the lane still ships', { timeout: 180_000 }, () => {
    expect(outcome551.designArtifact).toBeNull();
    expect(
      outcome551.events.some((e) => e.type === 'design_artifact_invalid' && e.msg.includes('interfacesTouched')),
    ).toBe(true);
    expect(outcome551.state).toBe('shipped');
    // When #551 lands: designArtifact becomes non-null and interfacesTouched has length 2.
  });

  it(
    '#1222 fixed behaviour (#1172): commits uncommitted build output after a green check and ships',
    { timeout: 180_000 },
    () => {
      expect(outcome1222.state).toBe('shipped');
      expect(outcome1222.prNumber).toBeDefined();
      expect(outcome1222.githubCalls.some(([name]) => name === 'pulls.create')).toBe(true);
      expect(
        outcome1222.events.some(
          (e) => e.type === 'ship' && /committed 1 uncommitted path\(s\) left after check/.test(e.msg),
        ),
      ).toBe(true);
      // Acceptance criterion 2: the pre-#1172 dirty-worktree park must never come back.
      expect(outcome1222.events.some((e) => e.msg.includes('worktree has uncommitted changes'))).toBe(false);
    },
  );

  it('control run keeps its design artifact', { timeout: 180_000 }, () => {
    expect(controlOutcome.state).toBe('shipped');
    expect(controlOutcome.designArtifact).not.toBeNull();
    expect(controlOutcome.designArtifact?.interfacesTouched).toContain('feature-9552.txt');
  });

  it('fixture registry', () => {
    expect(SIM_REGRESSION_FIXTURES.map((f) => f.fault)).toEqual([550, 551, 1222]);
    for (const fixture of SIM_REGRESSION_FIXTURES) {
      expect(fixture.name.length).toBeGreaterThan(0);
      expect(fixture.historicalSignature.length).toBeGreaterThan(0);
    }
    expect(simRegressionFixture(550).spec.issue).toBe(9550);
    expect(() => simRegressionFixture(999)).toThrow();
  });

  it('simSpecWithObjectInterface shape', () => {
    const content = simSpecWithObjectInterface(9999, 'shape check');
    const parsed = matter(content);
    const design = parsed.data.design as { interfacesTouched: unknown[] };
    expect(design.interfacesTouched).toHaveLength(2);
    expect(typeof design.interfacesTouched[1]).toBe('object');

    const result = DesignArtifactSchema.safeParse(design);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'interfacesTouched.1')).toBe(true);
    }
  });
});
