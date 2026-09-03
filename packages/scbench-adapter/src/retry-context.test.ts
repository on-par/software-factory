import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseEvaluation, type ScbenchEvaluation } from './baseline.js';
import { buildRetryContext, retrySkipReason, RETRY_PASS_POLICY } from './retry-context.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/retry/', import.meta.url));

function loadFixture(name: string): ScbenchEvaluation {
  const path = `${FIXTURES}${name}`;
  return parseEvaluation(readFileSync(path, 'utf-8'), path);
}

describe('buildRetryContext', () => {
  it('builds the structured context from a failed evaluation fixture', () => {
    const ctx = buildRetryContext(loadFixture('evaluation-failed.json'));

    expect(ctx.problemId).toBe('cfgpipe');
    expect(ctx.checkpointId).toBe('checkpoint_1');
    expect(ctx.passPolicy).toBe('core-cases');
    expect(ctx.passPolicy).toBe(RETRY_PASS_POLICY);
    expect(ctx.pytestExitCode).toBe(1);
    expect(ctx.failedTests).toEqual([
      { group: 'checkpoint_1-Core', name: 'test_cli_arg_forms[arg_candidates0]' },
      { group: 'checkpoint_1-Core', name: 'test_missing_required_param' },
      { group: 'checkpoint_1-Error', name: 'test_env_parse_error_priority' },
    ]);
  });

  it('truncates a long stderr at 2000 chars with a marker while short stdout passes through', () => {
    const evaluation = loadFixture('evaluation-failed.json');
    const ctx = buildRetryContext(evaluation);

    expect(evaluation.stderr!.length).toBeGreaterThan(2000);
    expect(ctx.stderrExcerpt).toBe(`${evaluation.stderr!.slice(0, 2000)}\n… [truncated]`);
    expect(ctx.stdoutExcerpt).toBe(evaluation.stdout);
    expect(ctx.stdoutExcerpt).not.toContain('[truncated]');
  });

  it('yields failedTests: [] when the evaluation carries no tests map', () => {
    const evaluation = loadFixture('evaluation-failed.json');
    delete evaluation.tests;

    expect(buildRetryContext(evaluation).failedTests).toEqual([]);
  });

  it('omits excerpt fields when stdout/stderr are absent — never synthesizes them', () => {
    const evaluation = loadFixture('evaluation-failed.json');
    delete evaluation.stdout;
    delete evaluation.stderr;

    const ctx = buildRetryContext(evaluation);

    expect('stdoutExcerpt' in ctx).toBe(false);
    expect('stderrExcerpt' in ctx).toBe(false);
  });

  it('omits excerpt fields for empty stdout/stderr strings', () => {
    const ctx = buildRetryContext({ ...loadFixture('evaluation-failed.json'), stdout: '', stderr: '' });

    expect('stdoutExcerpt' in ctx).toBe(false);
    expect('stderrExcerpt' in ctx).toBe(false);
  });
});

describe('retrySkipReason', () => {
  it('returns undefined for a failed, retryable evaluation', () => {
    expect(retrySkipReason(loadFixture('evaluation-failed.json'))).toBeUndefined();
  });

  it('returns a reason for a passing evaluation', () => {
    expect(retrySkipReason(loadFixture('evaluation-passed.json'))).toBe(
      'checkpoint fully green — every test group passed, nothing to rework',
    );
  });

  it('is rework-eligible when Core is green but Functionality has failures (circuit_eval checkpoint 3)', () => {
    expect(retrySkipReason(loadFixture('evaluation-circuit-eval-checkpoint3.json'))).toBeUndefined();
  });

  it('returns a reason for an infrastructure failure', () => {
    expect(retrySkipReason(loadFixture('evaluation-infra.json'))).toBe(
      'infrastructure failure — provider fault, not a code fault',
    );
  });

  it('does not let a vacuous 0/0 Core mask failures in other groups', () => {
    const evaluation = loadFixture('evaluation-circuit-eval-checkpoint3.json');
    const vacuousCore = {
      ...evaluation,
      pass_counts: { Functionality: 66 },
      total_counts: { Functionality: 82 },
    };

    expect(retrySkipReason(vacuousCore)).toBeUndefined();
  });

  it('skips a checkpoint green in every group, not just Core', () => {
    const evaluation = loadFixture('evaluation-passed.json');
    const allGreen = {
      ...evaluation,
      pass_counts: { Core: 4, Functionality: 10 },
      total_counts: { Core: 4, Functionality: 10 },
    };

    expect(retrySkipReason(allGreen)).toBe('checkpoint fully green — every test group passed, nothing to rework');
  });
});
