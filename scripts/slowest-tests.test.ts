import { describe, expect, it } from 'vitest';

import {
  formatSlowestFiles,
  parseFileDurations,
  runSlowestTestsCli,
  slowestFiles,
  type FileDuration,
} from './slowest-tests.js';

function report(entries: Array<[string, number]>): unknown {
  return {
    testResults: entries.map(([name, ms]) => ({ name: `/repo/${name}`, startTime: 1000, endTime: 1000 + ms })),
  };
}

const SEVEN: Array<[string, number]> = [
  ['a.test.ts', 100],
  ['b.test.ts', 7000],
  ['c.test.ts', 300],
  ['d.test.ts', 5000],
  ['e.test.ts', 4000],
  ['f.test.ts', 6000],
  ['g.test.ts', 200],
];

describe('parseFileDurations', () => {
  it('maps names to repo-relative paths and computes endTime - startTime', () => {
    expect(parseFileDurations(report([['packages/x/a.test.ts', 250]]), '/repo')).toEqual([
      { file: 'packages/x/a.test.ts', durationMs: 250 },
    ]);
  });

  it('returns [] for null, {}, missing or non-array testResults', () => {
    expect(parseFileDurations(null, '/repo')).toEqual([]);
    expect(parseFileDurations({}, '/repo')).toEqual([]);
    expect(parseFileDurations({ testResults: 'x' }, '/repo')).toEqual([]);
  });

  it('skips entries with a missing name or non-numeric times', () => {
    const r = {
      testResults: [
        { startTime: 1, endTime: 2 },
        { name: '/repo/a.test.ts', startTime: 'x', endTime: 2 },
        { name: '/repo/b.test.ts', startTime: 1, endTime: null },
        'junk',
        { name: '/repo/ok.test.ts', startTime: 1, endTime: 4 },
      ],
    };
    expect(parseFileDurations(r, '/repo')).toEqual([{ file: 'ok.test.ts', durationMs: 3 }]);
  });
});

describe('slowestFiles', () => {
  const durations = parseFileDurations(report(SEVEN), '/repo');

  it('returns exactly 5, sorted descending', () => {
    const top = slowestFiles(durations);
    expect(top.map((f) => f.file)).toEqual(['b.test.ts', 'f.test.ts', 'd.test.ts', 'e.test.ts', 'c.test.ts']);
  });

  it('breaks ties by file name', () => {
    const tied: FileDuration[] = [
      { file: 'z.ts', durationMs: 5 },
      { file: 'a.ts', durationMs: 5 },
    ];
    expect(slowestFiles(tied).map((f) => f.file)).toEqual(['a.ts', 'z.ts']);
  });

  it('returns all files when fewer than 5', () => {
    expect(slowestFiles(durations.slice(0, 3))).toHaveLength(3);
  });

  it('does not mutate its input', () => {
    const copy = [...durations];
    slowestFiles(durations);
    expect(durations).toEqual(copy);
  });
});

describe('formatSlowestFiles', () => {
  it('prints a header and one line per file with seconds to 2 decimals', () => {
    expect(
      formatSlowestFiles([
        { file: 'a.test.ts', durationMs: 12345 },
        { file: 'b.test.ts', durationMs: 50 },
      ]),
    ).toBe('Slowest 2 test files:\n    12.35s  a.test.ts\n     0.05s  b.test.ts');
  });
});

describe('runSlowestTestsCli', () => {
  it('prints exactly the 5 slowest files, slowest first, with durations', () => {
    const lines: string[] = [];
    const code = runSlowestTestsCli(['r.json'], {
      readFile: () => JSON.stringify(report(SEVEN)),
      log: (l) => lines.push(l),
      cwd: '/repo',
    });
    expect(code).toBe(0);
    const out = lines.join('\n').split('\n');
    expect(out[0]).toBe('Slowest 5 test files:');
    const fileLines = out.slice(1);
    expect(fileLines).toHaveLength(5);
    const seconds = fileLines.map((l) => Number.parseFloat(l.trim()));
    expect(seconds).toEqual([7, 6, 5, 4, 0.3]);
    expect(fileLines[0]).toContain('b.test.ts');
    expect(out.join('\n')).not.toContain('a.test.ts');
    expect(out.join('\n')).not.toContain('g.test.ts');
  });

  it('returns 0 for a missing or malformed report', () => {
    const cases: Array<() => string> = [
      () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      () => 'not json',
      () => '{}',
    ];
    for (const readFile of cases) {
      const lines: string[] = [];
      expect(runSlowestTestsCli(['r.json'], { readFile, log: (l) => lines.push(l), cwd: '/repo' })).toBe(0);
      expect(lines).toEqual(['slowest-tests: no per-file durations in r.json']);
    }
  });
});
