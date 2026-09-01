// packages/scbench-adapter/src/compare.test.ts — regression comparison between two retained measured SCBench runs (#1135).
import { describe, expect, it } from 'vitest';

import type { BaselineTrial, BaselineTrialEvidence, ScbenchEvaluation } from './baseline.js';
import { compareTrialSets, renderComparisonReport } from './compare.js';
import { minimalManifest } from './manifest-fixture.js';

function minimalEvaluation(overrides: Partial<ScbenchEvaluation> = {}): ScbenchEvaluation {
  return {
    problem_name: 'cfgpipe',
    checkpoint_name: 'checkpoint_1',
    pass_counts: { Core: 3 },
    total_counts: { Core: 3 },
    pytest_exit_code: 0,
    infrastructure_failure: false,
    ...overrides,
  };
}

function makeTrial(id: string, evidence: Partial<BaselineTrialEvidence> = {}): BaselineTrial {
  return {
    id,
    manifestPath: `/runs/${id}/manifest.json`,
    manifest: minimalManifest(),
    evidence: { runInfoPresent: false, ...evidence },
  };
}

const passingTrial = (id: string) => makeTrial(id, { evaluation: minimalEvaluation() });
const failingTrial = (id: string) =>
  makeTrial(id, { evaluation: minimalEvaluation({ pass_counts: { Core: 2 }, total_counts: { Core: 3 } }) });

describe('compareTrialSets', () => {
  it('reports a regression when the candidate fails what the baseline passed', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [failingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    expect(result.entries).toEqual([
      expect.objectContaining({ key: 'cfgpipe/checkpoint_1', status: 'regression', deltaPoints: -100 }),
    ]);
    expect(result.maxRegressionPoints).toBe(100);
    expect(result.exceedsThreshold).toBe(true);
  });

  it('reports no-change when both sides pass identically', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    expect(result.entries).toEqual([expect.objectContaining({ status: 'no-change', deltaPoints: 0 })]);
    expect(result.maxRegressionPoints).toBe(0);
    expect(result.exceedsThreshold).toBe(false);
  });

  it('reports improvement without ever gating', () => {
    const result = compareTrialSets(
      [failingTrial('cfgpipe/checkpoint_1/trial-1')],
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    expect(result.entries).toEqual([expect.objectContaining({ status: 'improvement', deltaPoints: 100 })]);
    expect(result.exceedsThreshold).toBe(false);
  });

  it('never counts missing evidence as a pass, on either side', () => {
    const candidateResult = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [makeTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );
    const [entry] = candidateResult.entries;
    if (entry.status !== 'regression') throw new Error(`expected regression, got ${entry.status}`);
    expect(entry.candidate).toEqual({ passes: 0, fails: 0, infrastructureFailures: 0, missingEvidence: 1, total: 1 });

    const baselineResult = compareTrialSets(
      [makeTrial('cfgpipe/checkpoint_1/trial-1'), passingTrial('cfgpipe/checkpoint_1/trial-2')],
      [passingTrial('cfgpipe/checkpoint_1/trial-1'), passingTrial('cfgpipe/checkpoint_1/trial-2')],
      0,
    );
    const [baselineEntry] = baselineResult.entries;
    if (baselineEntry.status !== 'improvement') throw new Error(`expected improvement, got ${baselineEntry.status}`);
    expect(baselineEntry.baseline).toEqual({
      passes: 1,
      fails: 0,
      infrastructureFailures: 0,
      missingEvidence: 1,
      total: 2,
    });
  });

  it('never counts an infrastructure failure as a pass', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [makeTrial('cfgpipe/checkpoint_1/trial-1', { evaluation: minimalEvaluation({ infrastructure_failure: true }) })],
      0,
    );

    const [entry] = result.entries;
    if (entry.status !== 'regression') throw new Error(`expected regression, got ${entry.status}`);
    expect(entry.candidate).toEqual({ passes: 0, fails: 0, infrastructureFailures: 1, missingEvidence: 0, total: 1 });
  });

  it('gates strictly on the threshold boundary', () => {
    const baseline = [passingTrial('cfgpipe/checkpoint_1/trial-1'), passingTrial('cfgpipe/checkpoint_1/trial-2')];
    const candidate = [passingTrial('cfgpipe/checkpoint_1/trial-1'), failingTrial('cfgpipe/checkpoint_1/trial-2')];

    expect(compareTrialSets(baseline, candidate, 50).exceedsThreshold).toBe(false);
    expect(compareTrialSets(baseline, candidate, 49.9).exceedsThreshold).toBe(true);
  });

  it('reports one-sided groups without gating', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [passingTrial('code_search/checkpoint_1/trial-1')],
      0,
    );

    expect(result.entries).toEqual([
      expect.objectContaining({ key: 'cfgpipe/checkpoint_1', status: 'baseline-only' }),
      expect.objectContaining({ key: 'code_search/checkpoint_1', status: 'candidate-only' }),
    ]);
    expect(result.entries[0]).not.toHaveProperty('deltaPoints');
    expect(result.entries[1]).not.toHaveProperty('deltaPoints');
    expect(result.maxRegressionPoints).toBe(0);
    expect(result.exceedsThreshold).toBe(false);
  });

  it('aggregates multiple trials per group into a group pass rate', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1'), passingTrial('cfgpipe/checkpoint_1/trial-2')],
      [passingTrial('cfgpipe/checkpoint_1/trial-1'), failingTrial('cfgpipe/checkpoint_1/trial-2')],
      0,
    );

    expect(result.maxRegressionPoints).toBe(50);
    expect(result.entries[0].status).toBe('regression');
  });

  it('handles empty inputs', () => {
    const result = compareTrialSets([], [], 0);
    expect(result.entries).toEqual([]);
    expect(result.exceedsThreshold).toBe(false);
    expect(result.maxRegressionPoints).toBe(0);
  });

  it('sorts entries by key regardless of input order', () => {
    const result = compareTrialSets(
      [passingTrial('code_search/checkpoint_1/trial-1'), passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [passingTrial('code_search/checkpoint_1/trial-1'), passingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    expect(result.entries.map((e) => e.key)).toEqual(['cfgpipe/checkpoint_1', 'code_search/checkpoint_1']);
  });
});

describe('renderComparisonReport', () => {
  it('renders a regression report with the group key, rates, drop, and a failing verdict', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [failingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    const report = renderComparisonReport(result);

    expect(report).toContain('cfgpipe/checkpoint_1');
    expect(report).toContain('REGRESSION');
    expect(report).toContain('100.0%');
    expect(report).toContain('0.0%');
    expect(report).toContain('drop 100.0 points');
    expect(report).toContain(
      'Verdict: REGRESSION — worst core-cases pass-rate drop 100.0 points exceeds threshold 0 points.',
    );
  });

  it('renders a no-change report with an OK verdict', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    const report = renderComparisonReport(result);
    expect(report).toContain('no change');
    expect(report).toContain('Verdict: OK');
  });

  it('includes the missing-evidence count in the per-side detail', () => {
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [makeTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );

    expect(renderComparisonReport(result)).toContain('1 missing evidence');
  });

  it('renders the no-comparable-trials line and an OK verdict for an empty result', () => {
    const report = renderComparisonReport(compareTrialSets([], [], 0));
    expect(report).toContain('No comparable trials recorded on either side.');
    expect(report).toContain('Verdict: OK — no measured core-cases regression.');
  });

  it('renders a baseline-only entry as not comparable', () => {
    const result = compareTrialSets([passingTrial('circuit_eval/checkpoint_1/trial-1')], [], 0);
    expect(renderComparisonReport(result)).toContain(
      'circuit_eval/checkpoint_1: not comparable — present only in the baseline run',
    );
  });

  it('renders a candidate-only entry as new in candidate', () => {
    const result = compareTrialSets([], [passingTrial('code_search/checkpoint_1/trial-1')], 0);
    expect(renderComparisonReport(result)).toContain('code_search/checkpoint_1: new in candidate');
  });

  it('renders an improvement entry with a gain line', () => {
    const result = compareTrialSets(
      [failingTrial('cfgpipe/checkpoint_1/trial-1')],
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      0,
    );
    expect(renderComparisonReport(result)).toContain(
      'improvement — core-cases pass rate 0.0% → 100.0% (gain 100.0 points',
    );
  });

  it('pluralizes multiple infrastructure failures in the per-side detail', () => {
    const infra = (id: string) => makeTrial(id, { evaluation: minimalEvaluation({ infrastructure_failure: true }) });
    const result = compareTrialSets(
      [passingTrial('cfgpipe/checkpoint_1/trial-1')],
      [infra('cfgpipe/checkpoint_1/trial-1'), infra('cfgpipe/checkpoint_1/trial-2')],
      0,
    );
    expect(renderComparisonReport(result)).toContain('2 infrastructure failures');
  });
});
