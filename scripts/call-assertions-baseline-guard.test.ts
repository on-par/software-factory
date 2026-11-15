import { describe, expect, it } from 'vitest';

import { runCallAssertionsBaselineGuard } from './call-assertions-baseline-guard.js';

const MISSING = 'missing';

function run(argv: string[], base: Record<string, number> | string, head: Record<string, number> | string) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = runCallAssertionsBaselineGuard(argv, {
    git: () => {
      if (base === MISSING) throw new Error('fatal: path does not exist');
      return typeof base === 'string' ? base : JSON.stringify(base);
    },
    readHead: () => (typeof head === 'string' ? head : JSON.stringify(head)),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { code, logs, errors };
}

const BASE = ['--base', 'abc123'];

describe('call-assertions baseline guard (#4051)', () => {
  it('fails when a baseline count is raised', () => {
    const { code, errors } = run(BASE, { 'a.test.ts': 2 }, { 'a.test.ts': 3 });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('raised a.test.ts from 2 to 3');
  });

  it('fails when a baseline entry is added', () => {
    const { code, errors } = run(BASE, { 'a.test.ts': 2 }, { 'a.test.ts': 2, 'b.test.ts': 1 });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('added b.test.ts at 1');
  });

  it('passes when entries are lowered or removed', () => {
    const { code, logs, errors } = run(BASE, { 'a.test.ts': 2, 'b.test.ts': 1 }, { 'a.test.ts': 1 });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join('\n')).toContain('1 lowered, 1 removed');
  });

  it('treats a missing base baseline as all entries added', () => {
    const { code, errors } = run(BASE, MISSING, { 'a.test.ts': 1 });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('added a.test.ts at 1');
  });

  it('rejects bad usage', () => {
    expect(run([], {}, {}).code).toBe(2);
    expect(run(['--base'], {}, {}).code).toBe(2);
    expect(run([...BASE, 'extra'], {}, {}).code).toBe(2);
  });

  it('fails on a malformed baseline', () => {
    expect(run(BASE, {}, '[]').errors.join('\n')).toContain('head call-assertions-baseline.json must be a JSON object');
    expect(run(BASE, {}, '{"a.test.ts":"x"}').code).toBe(1);
    expect(run(BASE, 'not json', {}).code).toBe(1);
  });
});
