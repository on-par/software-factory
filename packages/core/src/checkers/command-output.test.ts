// src/checkers/command-output.test.ts — summarizeCommandRun and parseCommandCounts

import { describe, expect, it } from 'vitest';

import type { CommandResult } from '../utils/command-runner.js';
import { parseCommandCounts, summarizeCommandRun } from './command-output.js';

function result(
  fields: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; command?: string[] } = {},
): CommandResult {
  const exitCode = fields.exitCode ?? 1;
  return {
    command: fields.command ?? ['npx', 'vitest', 'run'],
    stdout: fields.stdout ?? '',
    stderr: fields.stderr ?? '',
    exitCode,
    killed: false,
    timedOut: fields.timedOut ?? false,
    ok: exitCode === 0,
  } as CommandResult;
}

function vitestFail(file: string, name: string, expected: string): string {
  return [
    ` FAIL  ${file} > ${name}`,
    `AssertionError: expected ${expected} to be 4 // Object.is equality`,
    '- Expected',
    '+ Received',
    '- 4',
    `+ ${expected}`,
    '',
  ].join('\n');
}

describe('summarizeCommandRun', () => {
  it('keeps a 1 MB failing vitest run within 4,000 characters (#3264)', () => {
    let stdout = '';
    for (let i = 0; i < 300; i++) stdout += ` ✓ src/a.test.ts > passes ${i} 1ms\n`;
    while (stdout.length < 1_000_000) stdout += 'stdout | src/noise.test.ts > logs\nsome filler noise line\n';
    stdout += ' Failed Tests 2\n';
    stdout += vitestFail('src/math.test.ts', 'adds > sums two numbers', '3');
    stdout += [
      ' FAIL  src/str.test.ts > upper > uppercases',
      "AssertionError: expected 'a' to be 'A'",
      '',
      ' Test Files  2 failed | 1 passed (3)',
      '      Tests  2 failed | 300 passed (302)',
      '',
    ].join('\n');
    expect(stdout.length).toBeGreaterThanOrEqual(1_000_000);

    const out = summarizeCommandRun(result({ stdout }), { logPath: '/tmp/x.log' });

    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('2 failed | 300 passed');
    expect(out).toContain('adds > sums two numbers');
    expect(out).toContain('upper > uppercases');
    expect(out).toContain('AssertionError: expected 3 to be 4');
    expect(out).toContain("AssertionError: expected 'a' to be 'A'");
    expect(out.split('\n').at(-1)).toBe('full log: /tmp/x.log');
  });

  it('counts tsc errors and eslint problems and lists each location', () => {
    const tsc = summarizeCommandRun(
      result({
        command: ['npx', 'tsc'],
        stdout: [
          "src/a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.",
          "src/b.ts(2,1): error TS2304: Cannot find name 'x'.",
          "src/c.ts(9,9): error TS7006: Parameter 'p' implicitly has an 'any' type.",
          'Found 3 errors in 3 files.',
        ].join('\n'),
      }),
    );
    expect(tsc).toContain('3 errors');
    for (const loc of ['src/a.ts(1,5)', 'src/b.ts(2,1)', 'src/c.ts(9,9)']) expect(tsc).toContain(loc);

    const eslint = summarizeCommandRun(
      result({
        command: ['npx', 'eslint', '.'],
        stdout: [
          '/repo/src/a.ts',
          "  3:7  error  'x' is assigned a value but never used  no-unused-vars",
          "  5:2  error  'y' is assigned a value but never used  no-unused-vars",
          '',
          '/repo/src/b.ts',
          "  8:1  error  'z' is assigned a value but never used  no-unused-vars",
          "  11:4  error  'w' is assigned a value but never used  no-unused-vars",
          '',
          '✖ 4 problems (4 errors, 0 warnings)',
        ].join('\n'),
      }),
    );
    expect(eslint).toContain('4 problems');
    for (const loc of ['3:7', '5:2', '8:1', '11:4']) expect(eslint).toContain(loc);
    expect(eslint).toContain('/repo/src/b.ts:8:1');
  });

  it('drops failure blocks from the end with a count when 200 tests fail', () => {
    let stdout = '';
    for (let i = 1; i <= 200; i++) stdout += vitestFail(`src/t${i}.test.ts`, `case ${i}`, String(i));
    stdout += '      Tests  200 failed (200)\n';

    const out = summarizeCommandRun(result({ stdout }), { logPath: '/tmp/x.log' });
    const lines = out.split('\n');

    expect(out.length).toBeLessThanOrEqual(4000);
    expect(lines[0]).toMatch(/^\$ npx vitest run — exit 1/);
    expect(lines.at(-1)).toBe('full log: /tmp/x.log');
    const omitted = /… (\d+) more failures in the log/.exec(out);
    expect(omitted).not.toBeNull();
    expect(out).toContain('src/t1.test.ts > case 1\n');
    expect(out).not.toContain('case 200');
    const kept = lines.filter((l) => l.startsWith(' FAIL ')).length;
    expect(kept + Number(omitted![1])).toBe(200);
  });

  it('respects tiny caps with a long log path', () => {
    const stdout = vitestFail('src/a.test.ts', 'x', '1') + '      Tests  1 failed (1)\n';
    const out = summarizeCommandRun(result({ stdout }), { maxChars: 300, logPath: `/tmp/${'p'.repeat(100)}.log` });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith('$ npx vitest run')).toBe(true);
    expect(out.split('\n').at(-1)).toContain('full log: /tmp/');
  });

  it('shows duration and timeout in the header', () => {
    const out = summarizeCommandRun(result({ exitCode: 1, timedOut: true }), { durationMs: 1500 });
    expect(out.split('\n')[0]).toBe('$ npx vitest run — exit 1 in 1.5s (timed out)');
  });

  it('reports counts without blocks for a passing run', () => {
    const out = summarizeCommandRun(result({ exitCode: 0, stdout: '      Tests  5 passed (5)\n' }));
    expect(out).toBe('$ npx vitest run — exit 0\n5 passed');
  });

  it('falls back to the output tail for an unknown failing format', () => {
    const out = summarizeCommandRun(result({ stderr: 'boom: something exploded' }));
    expect(out).toContain('boom: something exploded');
  });

  it('reads jest and pytest summary lines', () => {
    expect(parseCommandCounts('Tests:       2 failed, 1 skipped, 300 passed, 303 total')?.line).toBe(
      '2 failed | 1 skipped | 300 passed',
    );
    expect(parseCommandCounts('=== 1 failed, 4 passed in 0.12s ===')).toMatchObject({
      format: 'pytest',
      line: '1 failed | 4 passed',
      failed: 1,
      passed: 4,
    });
  });

  it('returns null counts for plain text', () => {
    expect(parseCommandCounts('hello world')).toBeNull();
  });
});
