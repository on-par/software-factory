import { describe, expect, it } from 'vitest';

import { buildRerunPlan, RERUN_TIMEOUT_MS } from './flaky-rerun.js';
import type { TestsCommand } from './index.js';

const npm: TestsCommand = { runner: 'npm', argv: ['npm', 'test'], label: 'npm test' };
const pkgWith = (test: string) => ({ scripts: { test } }) as never;

describe('buildRerunPlan', () => {
  it('targets vitest failures serially with an escaped pattern', () => {
    const details = ' FAIL  a.test.ts > suite > adds (1+1) 12ms\n × suite > b.c works';
    const plan = buildRerunPlan(npm, pkgWith('vitest run'), details);
    expect(plan).toEqual({
      mode: 'targeted',
      argv: ['npm', 'test', '--', '-t', 'adds \\(1\\+1\\)|b\\.c works', '--no-file-parallelism'],
      timeoutMs: RERUN_TIMEOUT_MS,
      tests: ['adds \\(1\\+1\\)', 'b\\.c works'],
    });
    expect(RERUN_TIMEOUT_MS).toBe(600_000);
  });

  it('uses --runInBand for jest', () => {
    const plan = buildRerunPlan(npm, pkgWith('jest --ci'), ' × s > one');
    expect(plan.argv).toEqual(['npm', 'test', '--', '-t', 'one', '--runInBand']);
  });

  it('falls back to full for unknown runner, null pkg, and zero names', () => {
    expect(buildRerunPlan(npm, pkgWith('node --test'), ' × one')).toMatchObject({
      mode: 'full',
      argv: ['npm', 'test'],
      tests: [],
    });
    expect(buildRerunPlan(npm, null, ' × one').mode).toBe('full');
    expect(buildRerunPlan(npm, pkgWith('vitest'), 'npm ERR! boom').mode).toBe('full');
  });

  it('dedupes names sharing a last segment', () => {
    const plan = buildRerunPlan(npm, pkgWith('vitest'), ' × a > same\n × b > same');
    expect(plan.tests).toEqual(['same']);
  });

  it('targets pytest node ids', () => {
    const cmd: TestsCommand = { runner: 'pytest', argv: ['python3', '-m', 'pytest'], label: 'pytest' };
    const plan = buildRerunPlan(cmd, null, 'pytest failed: FAILED tests/x.py::test_a - AssertionError');
    expect(plan.mode).toBe('targeted');
    expect(plan.argv).toEqual(['python3', '-m', 'pytest', 'tests/x.py::test_a']);
    expect(plan.tests).toEqual(['tests/x.py::test_a']);
  });

  it('falls back to full for pytest without node ids', () => {
    const cmd: TestsCommand = {
      runner: 'pytest',
      argv: ['python3', '-m', 'pytest', '.factory/tests'],
      label: 'pytest',
    };
    expect(buildRerunPlan(cmd, null, ' × vitest style').argv).toEqual(['python3', '-m', 'pytest', '.factory/tests']);
  });

  it('falls back to full for verify and none', () => {
    const verify: TestsCommand = {
      runner: 'verify',
      argv: ['bash', 'scripts/verify.sh', '--no-e2e'],
      label: 'verify.sh',
    };
    expect(buildRerunPlan(verify, null, ' × one')).toEqual({
      mode: 'full',
      argv: ['bash', 'scripts/verify.sh', '--no-e2e'],
      timeoutMs: 600_000,
      tests: [],
    });
    expect(buildRerunPlan({ runner: 'none', argv: [], label: '' }, null, '').argv).toEqual([]);
  });

  it('returns a copy of argv', () => {
    const plan = buildRerunPlan(npm, null, '');
    plan.argv.push('x');
    expect(npm.argv).toEqual(['npm', 'test']);
  });
});
