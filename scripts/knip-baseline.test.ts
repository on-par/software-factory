import { describe, expect, it } from 'vitest';
import { compareKnipFindings, parseKnipReport, runKnipBaselineCli } from './knip-baseline.js';

const REPORT = {
  files: ['packages/core/src/orphan.ts'],
  issues: [
    {
      file: 'packages/core/src/testing.ts',
      owners: [],
      exports: [{ name: 'zebra' }, { name: 'alpha' }],
      types: [{ name: 'Beta' }],
    },
    { file: 'packages/core/src/a.ts', enumMembers: { Color: [{ name: 'Red' }] }, dependencies: ['left-pad'] },
  ],
};

function report(names: string[]): string {
  return JSON.stringify({ issues: [{ file: 'a.ts', exports: names.map((name) => ({ name })) }] });
}

function harness(opts: { knip?: (args: readonly string[]) => string; baseline: string }) {
  const lines: string[] = [];
  const written: string[] = [];
  const code = (argv: string[]) =>
    runKnipBaselineCli(argv, {
      runKnip: opts.knip ?? (() => report(['x'])),
      readFile: () => opts.baseline,
      writeFile: (_p, content) => {
        written.push(content);
      },
      log: (line) => lines.push(line),
    });
  return { lines, written, code };
}

const BASE = JSON.stringify({ default: ['default|exports|a.ts|x'], production: ['production|exports|a.ts|x'] });

describe('knip baseline', () => {
  it('parses knip json exports and types into stable mode|type|file|symbol keys', () => {
    expect(parseKnipReport(REPORT, 'production')).toContain('production|exports|packages/core/src/testing.ts|alpha');
    expect(parseKnipReport(REPORT, 'production')).toContain('production|types|packages/core/src/testing.ts|Beta');
    expect(parseKnipReport(REPORT, 'default')).toEqual([...parseKnipReport(REPORT, 'default')].sort());
  });

  it('parses top-level unused files and unknown issue types', () => {
    const keys = parseKnipReport(REPORT, 'default');
    expect(keys).toContain('default|files|packages/core/src/orphan.ts|');
    expect(keys).toContain('default|enumMembers|packages/core/src/a.ts|Red');
    expect(keys).toContain('default|dependencies|packages/core/src/a.ts|left-pad');
    expect(() => parseKnipReport([], 'default')).toThrow('not an object');
    expect(() => parseKnipReport({}, 'default')).toThrow('issues');
  });

  it('passes when findings equal the baseline', () => {
    const h = harness({ baseline: BASE });
    expect(h.code([])).toBe(0);
    expect(h.lines).toContain('knip: PASS');
    expect(compareKnipFindings(['a'], ['a'])).toEqual({ kind: 'pass' });
  });

  it('fails and names a new unused export not in the baseline', () => {
    const h = harness({ baseline: BASE, knip: () => report(['x', 'zzzDead']) });
    expect(h.code([])).toBe(1);
    expect(h.lines.join('\n')).toContain('default|exports|a.ts|zzzDead');
    expect(h.lines.join('\n')).toContain('new finding(s)');
  });

  it('fails and asks to delete a baselined finding that knip no longer reports', () => {
    const h = harness({ baseline: BASE, knip: () => report([]) });
    expect(h.code([])).toBe(1);
    expect(h.lines.join('\n')).toContain('delete these entries');
    expect(h.lines.join('\n')).toContain('production|exports|a.ts|x');
  });

  it('fails closed when knip output is not json', () => {
    const h = harness({ baseline: BASE, knip: () => 'not json' });
    expect(h.code([])).toBe(1);
    expect(h.lines.join('\n')).toContain('cannot run or parse knip (default)');
  });

  it('fails closed when the baseline is missing a mode', () => {
    const h = harness({ baseline: JSON.stringify({ default: [] }) });
    expect(h.code([])).toBe(1);
    expect(h.lines.join('\n')).toContain('cannot read baseline');
  });

  it('runs knip once in default and once in production mode', () => {
    const recorded: (readonly string[])[] = [];
    const h = harness({
      baseline: BASE,
      knip: (args) => {
        recorded.push(args);
        return report(['x']);
      },
    });
    h.code([]);
    expect(recorded).toEqual([
      ['--reporter', 'json', '--no-exit-code'],
      ['--production', '--reporter', 'json', '--no-exit-code'],
    ]);
  });

  it('write mode emits a sorted baseline', () => {
    const h = harness({ baseline: BASE, knip: () => report(['b', 'a']) });
    expect(h.code(['--write'])).toBe(0);
    expect(JSON.parse(h.written[0] ?? '')).toEqual({
      default: ['default|exports|a.ts|a', 'default|exports|a.ts|b'],
      production: ['production|exports|a.ts|a', 'production|exports|a.ts|b'],
    });
    expect(h.written[0]?.endsWith('}\n')).toBe(true);
  });

  it('prints help without running knip', () => {
    const h = harness({
      baseline: BASE,
      knip: () => {
        throw new Error('should not run');
      },
    });
    expect(h.code(['--help'])).toBe(0);
    expect(h.lines.join('\n')).toContain('must only shrink');
  });
});
