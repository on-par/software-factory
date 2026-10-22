// src/checkers/command-output.test.ts — summarizeCommandRun and the moved CHECK failure helpers

import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../utils/command-runner.js';
import { describeCommandFailureTail, describeTestFailure, summarizeCommandRun } from './command-output.js';

function result(
  stdout: string,
  extra: { stderr?: string; exitCode?: number; command?: string[]; timedOut?: boolean } = {},
): CommandResult {
  const exitCode = extra.exitCode ?? 1;
  const timedOut = extra.timedOut ?? false;
  return {
    command: extra.command ?? ['npm', 'test'],
    stdout,
    stderr: extra.stderr ?? '',
    exitCode,
    killed: timedOut,
    timedOut,
    ok: exitCode === 0 && !timedOut,
  } as CommandResult;
}

function vitestFail(name: string): string {
  return [
    ` FAIL  src/a.test.ts > suite > ${name}`,
    'AssertionError: expected 3 to be 4',
    '- Expected',
    '+ Received',
    '- 4',
    '+ 3',
    '',
  ].join('\n');
}

describe('summarizeCommandRun', () => {
  it('keeps a 1 MB failing vitest run within 4,000 characters (#3264)', () => {
    const passes = Array.from({ length: 300 }, (_, i) => ` ✓ src/a.test.ts > suite > passes ${i} 1ms`);
    const noise = 'stdout | src/a.test.ts > suite > noisy line with some padding text to grow the log\n'.repeat(13_000);
    const stdout = [
      '> vitest run',
      ...passes,
      noise,
      vitestFail('adds'),
      vitestFail('subtracts'),
      '      Tests  2 failed | 300 passed (302)',
    ].join('\n');
    expect(stdout.length).toBeGreaterThan(1_000_000);
    const out = summarizeCommandRun(result(stdout), { logPath: '/tmp/x.log' });
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('2 failed | 300 passed');
    expect(out).toContain('suite > adds');
    expect(out).toContain('suite > subtracts');
    expect(out.match(/AssertionError: expected 3 to be 4/g)).toHaveLength(2);
    expect(out.split('\n').at(-1)).toBe('full log: /tmp/x.log');
  });

  it('counts tsc errors and eslint problems and lists every error location', () => {
    const tsc = [
      'src/x.ts(1,2): error TS2322: Type A is not B.',
      'src/x.ts(5,6): error TS2304: Cannot find name c.',
      'src/y.ts(7,8): error TS2551: Nope.',
      'Found 3 errors in 2 files.',
    ].join('\n');
    const tscOut = summarizeCommandRun(result(tsc));
    expect(tscOut).toContain('typecheck: 3 errors');
    for (const loc of ['src/x.ts(1,2)', 'src/x.ts(5,6)', 'src/y.ts(7,8)']) expect(tscOut).toContain(loc);

    const eslint = [
      '/repo/a.ts',
      '  1:1  error  Unexpected any  no-explicit-any',
      '  2:3  error  Unused  no-unused-vars',
      '',
      '/repo/b.ts',
      '  4:5  error  Bad  eqeqeq',
      '  9:9  error  Worse  no-empty',
      '',
      '✖ 4 problems (4 errors, 0 warnings)',
    ].join('\n');
    const eslintOut = summarizeCommandRun(result(eslint));
    expect(eslintOut).toContain('lint: 4 problems (4 errors, 0 warnings)');
    for (const loc of ['/repo/a.ts:1:1', '/repo/a.ts:2:3', '/repo/b.ts:4:5', '/repo/b.ts:9:9']) {
      expect(eslintOut).toContain(loc);
    }
  });

  it('drops failure blocks from the end and reports how many were left out', () => {
    const stdout = Array.from({ length: 200 }, (_, i) => vitestFail(`case${i}`)).join('\n');
    const out = summarizeCommandRun(result(stdout), { logPath: '/tmp/x.log' });
    const lines = out.split('\n');
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(lines[0]).toMatch(/^\$ npm test — exit 1/);
    expect(lines.at(-1)).toBe('full log: /tmp/x.log');
    expect(out).toContain('suite > case0\n');
    const left = Number(/… (\d+) more failures in the log/.exec(out)?.[1]);
    const kept = (out.match(/FAIL {2}src/g) ?? []).length;
    expect(kept + left).toBe(200);
  });

  it('renders jest and pytest counts', () => {
    expect(summarizeCommandRun(result('Tests:       1 failed, 4 passed, 5 total'))).toContain(
      'tests: 1 failed | 4 passed',
    );
    expect(summarizeCommandRun(result('===== 2 failed, 8 passed, 1 skipped in 1.20s ====='))).toContain(
      'tests: 2 failed | 8 passed | 1 skipped',
    );
  });

  it('adds timeout and duration to the header, and omits the log line without a logPath', () => {
    const out = summarizeCommandRun(result('', { timedOut: true, exitCode: -1 }), { durationMs: 12_345 });
    expect(out.split('\n')[0]).toBe('$ npm test — exit -1 (timed out) in 12.3s');
    expect(out).not.toContain('full log:');
  });

  it('falls back to the output tail on an unrecognized failed run and gives only the header on a pass', () => {
    const failed = summarizeCommandRun(result('banner\nsomething broke', { exitCode: 2 }), { logPath: '/l' });
    expect(failed).toContain('something broke');
    const passed = summarizeCommandRun(result('all good', { exitCode: 0 }), { logPath: '/l' });
    expect(passed).toBe('$ npm test — exit 0\nfull log: /l');
  });

  it('holds the cap with a tiny maxChars and a long command', () => {
    const stdout = vitestFail('adds');
    const out = summarizeCommandRun(result(stdout, { command: ['x'.repeat(500)] }), {
      maxChars: 120,
      logPath: '/tmp/x.log',
    });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.split('\n').at(-1)).toBe('full log: /tmp/x.log');
  });

  it('ignores npm script echo lines and strips ANSI codes', () => {
    const echo = summarizeCommandRun(result('> FAIL a > b runner\nok', { exitCode: 0 }));
    expect(echo).toBe('$ npm test — exit 0');
    const ansi = summarizeCommandRun(result(`\u001b[31m FAIL  a.test.ts > s > t\u001b[0m\nboom`));
    expect(ansi).toContain('FAIL  a.test.ts > s > t\nboom');
    expect(ansi).not.toContain('\u001b');
  });
});

describe('moved CHECK helpers', () => {
  it('describeTestFailure returns the first failure plus stderr', () => {
    const out = describeTestFailure(result(vitestFail('adds'), { stderr: 'oops' }), 500);
    expect(out).toContain('FAIL  src/a.test.ts > suite > adds');
    expect(out).toContain('stderr:\noops');
  });

  it('describeCommandFailureTail falls back to the exit code', () => {
    expect(describeCommandFailureTail(result('', { exitCode: 3 }), 100)).toBe('exit code 3');
  });
});
