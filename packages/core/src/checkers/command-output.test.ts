import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../utils/command-runner.js';
import { describeTestFailure, extractFailedTestEvidence, outputTail, summarizeCommandRun } from './command-output.js';

function run(stdout: string, extra: Partial<CommandResult> = {}): CommandResult {
  const exitCode = extra.exitCode ?? 1;
  return {
    command: ['npm', 'test'],
    stdout,
    stderr: '',
    exitCode,
    killed: false,
    timedOut: false,
    ok: exitCode === 0,
    ...extra,
  };
}

function failBlock(name: string): string {
  return [
    ` FAIL  src/b.test.ts > suite > ${name}`,
    'AssertionError: expected 1 to be 2',
    '- Expected',
    '+ Received',
    '',
    ' ❯ src/b.test.ts:10:5',
  ].join('\n');
}

describe('summarizeCommandRun', () => {
  it('keeps a 1 MB failing vitest run within 4,000 characters (#3264)', () => {
    const passes = Array.from({ length: 300 }, (_, i) => ` ✓ src/a.test.ts > suite > passes ${i}`);
    const noise = 'x'.repeat(99);
    const noiseLines = Array.from({ length: 10_500 }, () => `log ${noise}`);
    const stdout = [
      ...passes,
      failBlock('breaks one'),
      ...noiseLines,
      failBlock('breaks two'),
      '',
      ' Tests  2 failed | 300 passed (302)',
    ].join('\n');
    expect(stdout.length).toBeGreaterThan(1_000_000);

    const out = summarizeCommandRun(run(stdout), { logPath: '/tmp/x.log' });

    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('breaks one');
    expect(out).toContain('breaks two');
    expect(out).toContain('AssertionError: expected 1 to be 2');
    expect(out).toContain('2 failed | 300 passed');
    expect(out.split('\n').at(-1)).toBe('full log: /tmp/x.log');
  });

  it('counts tsc errors and eslint problems and lists each location', () => {
    const tsc = [
      'src/x.ts(1,2): error TS2322: Type string is not assignable to type number.',
      '  Types are incompatible.',
      'src/x.ts(5,1): error TS2304: Cannot find name foo.',
      'src/y.ts(7,3): error TS2551: Property bar does not exist.',
      'Found 3 errors in 2 files.',
    ].join('\n');
    const tscOut = summarizeCommandRun(run(tsc, { command: ['tsc'] }));
    expect(tscOut).toContain('tsc: 3 errors');
    for (const loc of ['src/x.ts(1,2)', 'src/x.ts(5,1)', 'src/y.ts(7,3)']) expect(tscOut).toContain(loc);
    expect(tscOut).toContain('Types are incompatible.');

    const eslint = [
      '/repo/src/a.ts',
      '  3:5  error  Unexpected any  no-explicit-any',
      '  9:1  error  Missing semi  semi',
      '',
      '/repo/src/b.ts',
      '  1:1  error  Unused var  no-unused-vars',
      '  2:2  error  Unused var  no-unused-vars',
      '',
      '✖ 4 problems (4 errors, 0 warnings)',
    ].join('\n');
    const eslintOut = summarizeCommandRun(run(eslint, { command: ['eslint', '.'] }));
    expect(eslintOut).toContain('eslint: 4 problems (4 errors, 0 warnings)');
    for (const loc of ['/repo/src/a.ts', '3:5', '9:1', '/repo/src/b.ts', '1:1', '2:2']) {
      expect(eslintOut).toContain(loc);
    }
  });

  it('drops failure blocks from the end and reports how many were left out', () => {
    const stdout = Array.from({ length: 200 }, (_, i) => failBlock(`case ${i}`)).join('\n');
    const out = summarizeCommandRun(run(stdout), { logPath: '/tmp/y.log', durationMs: 1234.4 });
    const outLines = out.split('\n');

    expect(out.length).toBeLessThanOrEqual(4000);
    expect(outLines[0]).toBe('$ npm test');
    expect(out).toContain('exit code: 1');
    expect(out).toContain('duration: 1234ms');
    expect(outLines.at(-1)).toBe('full log: /tmp/y.log');
    const rendered = outLines.filter((l) => l.includes('FAIL  src/b.test.ts')).length;
    expect(rendered).toBeGreaterThan(0);
    expect(out).toContain(`… ${200 - rendered} more failures in the log`);
  });

  it('counts jest and pytest results', () => {
    const jest = summarizeCommandRun(run('Tests:       2 failed, 1 skipped, 300 passed, 303 total'));
    expect(jest).toContain('tests: 2 failed | 300 passed | 1 skipped');
    const pytest = summarizeCommandRun(run('=== 2 failed, 300 passed, 1 skipped in 1.2s ==='));
    expect(pytest).toContain('tests: 2 failed | 300 passed | 1 skipped');
  });

  it('strips ANSI colour and renders timed-out and no-log cases', () => {
    const esc = String.fromCharCode(27);
    const out = summarizeCommandRun(run(`${esc}[31m FAIL ${esc}[39m src/c.test.ts > s > t\nboom`, { timedOut: true }));
    expect(out).not.toContain(esc);
    expect(out).toContain('exit code: 1 (timed out)');
    expect(out).toContain('FAIL  src/c.test.ts > s > t');
    expect(out).not.toContain('full log:');
    expect(out).not.toContain('duration:');
  });

  it('holds a tiny cap and keeps the header and footer', () => {
    const stdout = Array.from({ length: 5 }, (_, i) => failBlock(`case ${i}`)).join('\n');
    const result = run(stdout, { command: ['npm', 'run', 'test', '--', 'x'.repeat(200)] });
    const out = summarizeCommandRun(result, { maxChars: 120, logPath: '/tmp/z.log' });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.startsWith('$ npm run test')).toBe(true);
    expect(out).toContain('exit code: 1');
    expect(out.split('\n').at(-1)).toBe('full log: /tmp/z.log');
  });

  it('falls back to the output tail for an unrecognised failing run', () => {
    const out = summarizeCommandRun(run('banner\nsomething exploded'));
    expect(out).toContain('something exploded');
    expect(summarizeCommandRun(run('all good', { exitCode: 0 }))).not.toContain('all good');
  });
});

describe('moved helpers', () => {
  it('extractFailedTestEvidence returns the first vitest FAIL block', () => {
    const out = extractFailedTestEvidence(`noise\n${failBlock('one')}\n${failBlock('two')}`);
    expect(out).toContain('suite > one');
    expect(out?.startsWith('FAIL  src/b.test.ts > suite > one')).toBe(true);
    expect(extractFailedTestEvidence('all green')).toBeNull();
  });

  it('outputTail trims to a line start with an ellipsis', () => {
    const text = `${'a'.repeat(30)}\nline two\nline three`;
    expect(outputTail(text, 22)).toBe('…line two\nline three');
    expect(outputTail('short', 100)).toBe('short');
  });

  it('describeTestFailure appends stderr to stdout evidence', () => {
    const out = describeTestFailure(run(failBlock('one'), { stderr: 'warn: something' }), 500);
    expect(out).toContain('suite > one');
    expect(out).toContain('stderr:\nwarn: something');
  });
});
