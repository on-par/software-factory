// src/checkers/command-output.test.ts — summarizeCommandRun and the moved CHECK output helpers (#3328)

import { describe, expect, it } from 'vitest';

import type { CommandResult } from '../utils/command-runner.js';
import { describeTestFailure, parseCommandRunCounts, summarizeCommandRun } from './command-output.js';

function run(stdout: string, exitCode = 1, extra: Partial<CommandResult & { durationMs: number }> = {}) {
  return { command: ['npm', 'test'], exitCode, stdout, stderr: '', timedOut: false, ...extra } as CommandResult & {
    durationMs?: number;
  };
}

function vitestFailure(name: string, expected: string, received: string): string[] {
  return [
    ` FAIL  src/${name}.test.ts > ${name} > case`,
    `AssertionError: expected ${received} to be ${expected} // Object.is equality`,
    '- Expected',
    '+ Received',
    `- ${expected}`,
    `+ ${received}`,
    '',
  ];
}

function bigVitestOutput(): string {
  const lines = ['> pkg@1.0.0 test', '> vitest run', ''];
  for (let i = 0; i < 300; i += 1) lines.push(` ✓ src/a.test.ts > suite > passes ${i} 2ms`);
  lines.push(...vitestFailure('math', '4', '3').map((l) => l.replace('math > case', 'math > adds')));
  lines.push(` FAIL  src/str.test.ts > str > trims`, "AssertionError: expected 'a ' to be 'a'", '');
  const noise = ['stdout | src/noise.test.ts', 'debug: '.padEnd(100, 'x')];
  let size = 0;
  while (size < 1_000_000) {
    lines.push(...noise);
    size += 110;
  }
  lines.push(' Test Files  2 failed | 10 passed (12)', '      Tests  2 failed | 300 passed (302)');
  return lines.join('\n');
}

describe('summarizeCommandRun', () => {
  it('keeps a 1 MB failing vitest run within 4,000 characters (#3264)', () => {
    const stdout = bigVitestOutput();
    expect(stdout.length).toBeGreaterThanOrEqual(1_000_000);
    const out = summarizeCommandRun(run(stdout), { logPath: '/tmp/x/tests.log' });
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain('2 failed | 300 passed');
    expect(out).toContain('math > adds');
    expect(out).toContain('str > trims');
    expect(out).toContain('expected 3 to be 4');
    expect(out).toContain("expected 'a ' to be 'a'");
    expect(out.split('\n').at(-1)).toBe('full log: /tmp/x/tests.log');
    expect(out.startsWith('$ npm test')).toBe(true);
  });

  it('reports tsc error and eslint problem counts with every location', () => {
    const tsc = [
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/b.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      'Found 3 errors in 2 files.',
    ].join('\n');
    const tscOut = summarizeCommandRun(run(tsc));
    expect(tscOut).toContain('tsc: 3 errors');
    for (const loc of ['src/a.ts(1,7)', 'src/b.ts(2,3)', 'src/b.ts(9,1)']) expect(tscOut).toContain(loc);

    const eslint = [
      '/repo/src/a.ts',
      '  3:5  error  Unexpected any  no-explicit-any',
      '  4:1  warning  Unused  no-unused-vars',
      '',
      '/repo/src/b.ts',
      '  7:2  error  Bad  eqeqeq',
      '  8:2  error  Bad  eqeqeq',
      '',
      '✖ 4 problems (3 errors, 1 warning)',
    ].join('\n');
    const eslintOut = summarizeCommandRun(run(eslint));
    expect(eslintOut).toContain('eslint: 4 problems (3 errors, 1 warning)');
    for (const loc of ['/repo/src/a.ts:3:5', '/repo/src/a.ts:4:1', '/repo/src/b.ts:7:2', '/repo/src/b.ts:8:2'])
      expect(eslintOut).toContain(loc);
  });

  it('drops failure blocks from the end and counts the omitted ones for 200 failures', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 200; i += 1) lines.push(...vitestFailure(`t${i}`, 'b', 'a'));
    const out = summarizeCommandRun(run(lines.join('\n')), { logPath: '/tmp/l.log' });
    expect(out.length).toBeLessThanOrEqual(4000);
    const outLines = out.split('\n');
    expect(outLines[0].startsWith('$ npm test — exit 1')).toBe(true);
    expect(outLines.at(-1)).toBe('full log: /tmp/l.log');
    const omitted = Number(/… (\d+) more failures in the log/.exec(out)?.[1]);
    const shown = out.match(/ FAIL {2}src\/t\d+\.test\.ts/g)?.length ?? 0;
    expect(shown + omitted).toBe(200);
    expect(out).toContain('src/t1.test.ts');
    expect(out).not.toContain('src/t200.test.ts');
  });

  it('omits the full log line without a logPath', () => {
    expect(summarizeCommandRun(run('boom'))).not.toContain('full log:');
  });

  it('gives no counts line for an unknown format and falls back to the output tail on failure', () => {
    const out = summarizeCommandRun(run('weird tool\nsomething broke'), { logPath: '/l' });
    expect(out).not.toMatch(/^(tests|tsc|eslint):/m);
    expect(out).toContain('something broke');
  });

  it('gives only the header and counts for a passing run', () => {
    const out = summarizeCommandRun(run('      Tests  5 passed (5)', 0, { durationMs: 850 }));
    expect(out).toBe('$ npm test — exit 0 in 850ms\ntests: 5 passed');
  });

  it('formats seconds, minutes and timeouts in the header', () => {
    expect(summarizeCommandRun(run('', 0, { durationMs: 12_300 }))).toContain('in 12.3s');
    expect(summarizeCommandRun(run('', 0, { durationMs: 125_000 }))).toContain('in 2m 05s');
    expect(summarizeCommandRun(run('', 1, { timedOut: true }))).toContain('(timed out)');
  });

  it('honours a custom maxChars', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i += 1) lines.push(...vitestFailure(`t${i}`, 'b', 'a'));
    const out = summarizeCommandRun(run(lines.join('\n')), { maxChars: 300, logPath: '/l' });
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('full log: /l')).toBe(true);
  });

  it('cuts a single oversized first block to fit', () => {
    const big = [' FAIL  src/a.test.ts > a > b', ...Array.from({ length: 11 }, () => 'x'.repeat(100))].join('\n');
    const out = summarizeCommandRun(run(big), { maxChars: 400, logPath: '/l' });
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain('…');
    expect(out.endsWith('full log: /l')).toBe(true);
  });

  it('truncates a header longer than maxChars and keeps the footer', () => {
    const out = summarizeCommandRun(run('', 1, { command: ['x'.repeat(200)] }), { maxChars: 50, logPath: '/l' });
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain('…');
    expect(out.endsWith('\nfull log: /l')).toBe(true);
  });
});

describe('parseCommandRunCounts', () => {
  it('parses jest and pytest summaries', () => {
    expect(parseCommandRunCounts('Tests:       2 failed, 300 passed, 302 total')).toMatchObject({
      format: 'jest',
      text: '2 failed | 300 passed',
    });
    expect(parseCommandRunCounts('===== 2 failed, 300 passed, 1 skipped in 1.23s =====')).toMatchObject({
      format: 'pytest',
      failed: 2,
      passed: 300,
      skipped: 1,
      text: '2 failed | 300 passed | 1 skipped',
    });
  });

  it('counts tsc error lines when there is no Found line', () => {
    expect(parseCommandRunCounts('a.ts(1,2): error TS1: x')).toMatchObject({
      format: 'tsc',
      errors: 1,
      text: '1 error',
    });
  });

  it('returns null for unrecognized output', () => {
    expect(parseCommandRunCounts('hello')).toBeNull();
  });
});

describe('describeTestFailure', () => {
  it('returns the first failing test evidence from stdout', () => {
    const r = run([' FAIL  src/a.test.ts > a > b', 'AssertionError: nope'].join('\n'));
    expect(describeTestFailure(r, 500)).toBe(' FAIL  src/a.test.ts > a > b\nAssertionError: nope'.trim());
  });
});
