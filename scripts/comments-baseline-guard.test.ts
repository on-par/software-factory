import { describe, expect, it } from 'vitest';

import { runCommentsBaselineGuard } from './comments-baseline-guard.js';

const MISSING = 'missing';

function run(argv: string[], base: Record<string, number> | string, head: Record<string, number> | string) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = runCommentsBaselineGuard(argv, {
    git: (args) => {
      if (args[0] === 'ls-tree') return base === MISSING ? '' : '100644 blob abc\tcomments-baseline.json\n';
      return typeof base === 'string' ? base : JSON.stringify(base);
    },
    readHead: () => (typeof head === 'string' ? head : JSON.stringify(head)),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { code, logs, errors };
}

const BASE = ['--base', 'abc123'];

describe('comments baseline guard (#4053)', () => {
  it('fails when a count is raised', () => {
    const { code, errors } = run(BASE, { 'a.ts': 2 }, { 'a.ts': 3 });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('raised a.ts from 2 to 3');
  });

  it('fails when an entry is added', () => {
    const { code, errors } = run(BASE, { 'a.ts': 2 }, { 'a.ts': 2, 'b.ts': 1 });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('added b.ts at 1');
  });

  it('passes when a count is lowered or removed', () => {
    const { code, logs, errors } = run(BASE, { 'a.ts': 2, 'b.ts': 1 }, { 'a.ts': 1 });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).toContain('1 lowered, 1 removed');
  });

  it('passes when the baseline is new at the base ref', () => {
    const { code, logs, errors } = run(BASE, MISSING, { 'a.ts': 1 });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).toContain('new at the base ref');
  });

  it('fails when the baseline is absent at base and head is malformed', () => {
    expect(run(BASE, MISSING, '[]').code).toBe(1);
  });

  it('rejects bad usage', () => {
    expect(run([], {}, {}).code).toBe(2);
    expect(run(['--base'], {}, {}).code).toBe(2);
    expect(run([...BASE, 'extra'], {}, {}).code).toBe(2);
  });

  it('fails on a malformed baseline', () => {
    expect(run(BASE, {}, '[]').errors.join('\n')).toContain('head comments-baseline.json must be a JSON object');
    expect(run(BASE, {}, '{"a.ts":"x"}').code).toBe(1);
    expect(run(BASE, 'not json', {}).code).toBe(1);
  });
});
