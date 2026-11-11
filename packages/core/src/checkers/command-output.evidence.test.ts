// src/checkers/command-output.evidence.test.ts — test console noise never stands in for the failure (#4018, #4011).
// Shapes follow a real `bash scripts/verify.sh --no-e2e` run under vitest's default + json reporters: each test's own
// console output is a `stderr | file > test` block (ended by a blank line) on stderr, the FAIL details close stderr,
// and the steps after vitest (slowest-tests, test-budget, eval, script tests) print to stdout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult, RunCommandOptions } from '../utils/command-runner.js';
import { combinedOutputTail, describeTestFailure, stripTestConsoleBlocks } from './command-output.js';
import { testsChecker } from './index.js';

const consoleBlock = (header: string, content: string): string => `${header}\n${content}\n\n`;
const V1_WARNING = consoleBlock(
  'stderr | packages/cli/src/cli/ship-config-source.test.ts > shipIssue config sources (#3906) > shipIssue logs the config source line',
  'factory: /tmp/t/factory-cli-x/.factory/config.yaml is v1 — loaded via the v1→v2 compatibility adapter; run `factory migrate` to rewrite it',
);
const DEPRECATION = consoleBlock(
  'stderr | packages/cli/src/cli/ship-no-pr.test.ts > run-issue --no-pr > rejects a size gate',
  "factory: --size-gate slice is deprecated; use 'stack'",
);
const RAW_STDERR_NOISE = 'codex: context ceiling off (ceiling 120000 >= context window 1000) for build_codex\n';
const PASSING_VITEST_STDOUT = [
  ' ✓ packages/core/src/a.test.ts (2 tests) 158ms',
  '',
  ' Test Files  1048 passed | 2 skipped (1050)',
  '      Tests  13691 passed | 8 skipped (13699)',
  '',
].join('\n');
const BUDGET_FAIL =
  'test-budget: FAIL — test step took 520s, over the 450s budget (scripts/test-budget.ts). Failing verify because CI is set.\n';

function result(stdout: string, stderr: string): CommandResult {
  return {
    command: ['bash', 'scripts/verify.sh', '--no-e2e'],
    stdout,
    stderr,
    exitCode: 1,
    killed: false,
    timedOut: false,
    ok: false,
  };
}

describe('stripTestConsoleBlocks', () => {
  it('drops each `stdout | ` / `stderr | ` block through its blank line and keeps everything else', () => {
    const text = `${V1_WARNING}${DEPRECATION}kept line\n${V1_WARNING}\n FAIL  a.test.ts > x\n`;
    expect(stripTestConsoleBlocks(text)).toBe('kept line\n\n FAIL  a.test.ts > x\n');
  });

  it('drops a block that runs to the end and ignores ANSI colour', () => {
    expect(stripTestConsoleBlocks('before\n\u001b[90mstdout | a.test.ts > t\u001b[39m\nlogged')).toBe('before');
  });
});

describe('describeTestFailure evidence (#4018)', () => {
  it('a real vitest failure quotes the failing test and its assertion, not the stderr of passing tests', () => {
    const stdout = [
      ' ❯ src/math.test.ts (2 tests | 1 failed) 12ms',
      '   × adds > sums 3ms',
      '',
      ' Test Files  1 failed | 1 passed (2)',
    ].join('\n');
    const stderr = [
      `${V1_WARNING}${DEPRECATION}${V1_WARNING}⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯`,
      '',
      ' FAIL  src/math.test.ts > adds > sums',
      'AssertionError: expected 3 to be 4 // Object.is equality',
    ].join('\n');

    const evidence = describeTestFailure(result(stdout, stderr), 500);

    expect(evidence).toContain('src/math.test.ts (2 tests | 1 failed)');
    expect(evidence).toContain('FAIL  src/math.test.ts > adds > sums');
    expect(evidence).toContain('AssertionError: expected 3 to be 4');
    expect(evidence).not.toContain('is v1');
    expect(evidence).not.toContain('ship-config-source');
    expect(evidence).not.toContain('deprecated');
  });

  it('a verify that fails after its tests is described by the failing step, from the arrival-order tail', () => {
    const slowest = 'Slowest test files:\n  12.0s packages/x.test.ts\n';
    const stdout = `${PASSING_VITEST_STDOUT}${slowest}${BUDGET_FAIL}`;
    const stderr = `${DEPRECATION}${RAW_STDERR_NOISE}${V1_WARNING}`;
    const combined = `${PASSING_VITEST_STDOUT}${DEPRECATION}${RAW_STDERR_NOISE}${V1_WARNING}${slowest}${BUDGET_FAIL}`;

    const evidence = describeTestFailure(result(stdout, stderr), 500, combined);

    expect(evidence).toContain('test-budget: FAIL — test step took 520s, over the 450s budget');
    expect(evidence).not.toContain('is v1');
    expect(evidence).not.toContain('ship-config-source');
  });

  it('without a streamed tail, console-only stderr no longer hides a stdout failure', () => {
    const evidence = describeTestFailure(
      result(`${PASSING_VITEST_STDOUT}${BUDGET_FAIL}`, `${DEPRECATION}${V1_WARNING}`),
      500,
    );

    expect(evidence).toContain('test-budget: FAIL');
    expect(evidence).not.toContain('is v1');
  });

  it('a real stderr error still wins over stdout when nothing streamed', () => {
    const leak = 'Error: Test run leaked 1 temp entry into /tmp: factory- (1: factory-x)\n';
    const evidence = describeTestFailure(result(PASSING_VITEST_STDOUT, `${V1_WARNING}${leak}`), 500);

    expect(evidence).toContain('Test run leaked 1 temp entry');
    expect(evidence).not.toContain('is v1');
  });
});

describe('combinedOutputTail', () => {
  it('keeps both streams in arrival order and only the last maxChars', () => {
    const tail = combinedOutputTail(12);
    tail.onOutput('stdout', Buffer.from('aaaaaaaaaa\n'));
    tail.onOutput('stderr', Buffer.from('warn\n'));
    tail.onOutput('stdout', Buffer.from('FAIL\n'));
    expect(tail.text()).toBe('a\nwarn\nFAIL\n');
  });

  it('decodes a multi-byte character split across chunks of one stream', () => {
    const tail = combinedOutputTail();
    const bytes = Buffer.from('a — b\n');
    tail.onOutput('stdout', bytes.subarray(0, 3));
    tail.onOutput('stdout', bytes.subarray(3));
    expect(tail.text()).toBe('a — b\n');
  });
});

describe('testsChecker FAIL details (#4018)', () => {
  const tmp = createTempDirs();
  afterAll(() => tmp.cleanup());

  it('names the step that failed after a green vitest run, not the last test warning on stderr', async () => {
    const worktree = tmp.makeSync('tests-evidence-');
    mkdirSync(join(worktree, 'scripts'));
    writeFileSync(join(worktree, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\n');
    const chunks: Array<['stdout' | 'stderr', string]> = [
      ['stdout', PASSING_VITEST_STDOUT],
      ['stderr', DEPRECATION],
      ['stderr', RAW_STDERR_NOISE],
      ['stderr', V1_WARNING],
      ['stdout', BUDGET_FAIL],
    ];
    const streamed = (name: 'stdout' | 'stderr') =>
      chunks
        .filter(([stream]) => stream === name)
        .map(([, text]) => text)
        .join('');

    const out = await testsChecker({
      worktree,
      specPath: '',
      env: {},
      runCommand: async (argv: readonly string[], options?: RunCommandOptions) => {
        for (const [stream, text] of chunks) options?.onOutput?.(stream, Buffer.from(text));
        return { ...result(streamed('stdout'), streamed('stderr')), command: [...argv] };
      },
    });

    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('verify.sh failed: ');
    expect(out.details).toContain('test-budget: FAIL — test step took 520s');
    expect(out.details).not.toContain('is v1');
    expect(out.details).not.toContain('ship-config-source.test.ts');
  });
});
