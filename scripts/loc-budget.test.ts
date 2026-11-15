import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { LabelEvent } from './max-lines-baseline-guard.js';
import { classifyPath, countLines, runLocBudget, type LocBudget, type LocBudgetIo } from './loc-budget.js';

const FILES: Record<string, string> = {
  'packages/a/src/x.ts': 'a\nb\n',
  'packages/a/src/x.test.ts': 'a\n',
  'packages/b/src/y.ts': 'a\n\n// c\n',
  'packages/b/dist/z.ts': 'ignored\n',
  'packages/b/README.md': 'ignored\n',
};

const label = (login: string, type = 'User'): LabelEvent => ({
  event: 'labeled',
  label: { name: 'loc-budget:override' },
  actor: { login, type },
});

interface Setup {
  budget: LocBudget | string;
  base?: LocBudget | 'missing' | 'unreachable';
  events?: LabelEvent[] | 'throw';
  env?: NodeJS.ProcessEnv;
}

function run(argv: string[], setup: Setup) {
  const out: string[] = [];
  const err: string[] = [];
  const io: LocBudgetIo = {
    cwd: '/repo',
    env: { GITHUB_REPOSITORY: 'o/r', ...setup.env },
    git: (args) => {
      if (args[0] === 'ls-files') return Object.keys(FILES).join('\0') + '\0';
      if (setup.base === 'unreachable') throw new Error('bad revision');
      if (args[0] === 'rev-parse') return 'abc';
      if (setup.base === undefined || setup.base === 'missing') throw new Error('bad object');
      return JSON.stringify(setup.base);
    },
    readFile: (path) =>
      path === 'loc-budget.json'
        ? typeof setup.budget === 'string'
          ? setup.budget
          : JSON.stringify(setup.budget)
        : (FILES[path] ?? ''),
    listPackages: () => ['a', 'b'],
    fetchLabelEvents: () => {
      if (setup.events === 'throw') throw new Error('events must not be fetched');
      return setup.events ?? [];
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { code: runLocBudget(argv, io), out, err };
}

const MATCHING: LocBudget = { a: { source: 2, tests: 1 }, b: { source: 3, tests: 0 } };
const GUARD = ['--base', 'abc', '--pr', '7'];

describe('countLines and classifyPath', () => {
  it('counts blank lines and comments like max-lines', () => {
    expect(countLines('a\n\n// c\n')).toBe(3);
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb')).toBe(2);
  });

  it('classifies test files as tests and other TypeScript as source', () => {
    expect(classifyPath('packages/core/src/a.test.ts')).toEqual({ pkg: 'core', kind: 'tests' });
    expect(classifyPath('packages/tui/src/a.spec.tsx')).toEqual({ pkg: 'tui', kind: 'tests' });
    expect(classifyPath('packages/core/src/x.ts')).toEqual({ pkg: 'core', kind: 'source' });
    expect(classifyPath('packages/core/dist/x.ts')).toBeUndefined();
    expect(classifyPath('packages/core/node_modules/x/y.ts')).toBeUndefined();
    expect(classifyPath('packages/core/README.md')).toBeUndefined();
    expect(classifyPath('scripts/x.ts')).toBeUndefined();
  });

  it('the committed loc-budget.json lists every package with source and test counts', () => {
    const root = new URL('../', import.meta.url);
    const budget = JSON.parse(readFileSync(new URL('loc-budget.json', root), 'utf8')) as LocBudget;
    const packages = readdirSync(new URL('packages/', root), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(new URL(`packages/${d.name}/package.json`, root)))
      .map((d) => d.name)
      .sort();
    expect(Object.keys(budget).sort()).toEqual(packages);
    for (const entry of Object.values(budget)) {
      expect(Number.isInteger(entry.source)).toBe(true);
      expect(Number.isInteger(entry.tests)).toBe(true);
    }
  });
});

describe('runLocBudget check mode', () => {
  it('passes when every package matches its budget', () => {
    const r = run([], { budget: MATCHING });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['loc-budget: every package matches loc-budget.json']);
  });

  it('fails a package under its budget and names the number to record', () => {
    const r = run([], { budget: { ...MATCHING, a: { source: 5, tests: 1 } } });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('packages/a source is 2 lines, under its loc-budget.json budget of 5');
    expect(r.err.join('\n')).toContain('lower the recorded number to 2');
  });

  it('fails a package over its budget', () => {
    const r = run([], { budget: { ...MATCHING, b: { source: 1, tests: 0 } } });
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('packages/b source is 3 lines, over its loc-budget.json budget of 1');
    expect(text).toContain('delete or reuse');
    expect(text).toContain('loc-budget:override');
  });

  it('fails a missing or unknown package', () => {
    const r = run([], { budget: { a: MATCHING['a']!, ghost: { source: 0, tests: 0 } } });
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('packages/b has no entry');
    expect(text).toContain('lists ghost but packages/ghost does not exist');
  });

  it('fails on a malformed loc-budget.json', () => {
    expect(run([], { budget: '[]' }).code).toBe(1);
    const r = run([], { budget: '{"a":{"source":-1,"tests":0}}' });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('entry a');
    expect(run([], { budget: 'nope' }).code).toBe(1);
  });

  it('rejects bad arguments with usage and exit 2', () => {
    for (const argv of [['--base', 'abc'], ['--base', 'abc', '--pr', 'x'], ['--nope']]) {
      const r = run(argv, { budget: MATCHING });
      expect(r.code).toBe(2);
      expect(r.err[0]).toContain('usage:');
    }
  });
});

describe('runLocBudget guard mode', () => {
  const lowerBase: LocBudget = { a: { source: 9, tests: 1 }, b: { source: 3, tests: 5 } };

  it('fails a raised budget without the override label', () => {
    const base: LocBudget = { a: { source: 1, tests: 1 }, b: { source: 3, tests: 0 } };
    const r = run(GUARD, { budget: MATCHING, base });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('loc-budget.json raised a.source from 1 to 2');
    expect(r.err.join('\n')).toContain('needs the loc-budget:override label applied by a human');
  });

  it('passes a raised budget when a human applied loc-budget:override', () => {
    const base: LocBudget = { a: { source: 1, tests: 1 }, b: { source: 3, tests: 0 } };
    const r = run(GUARD, { budget: MATCHING, base, events: [label('alice')] });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('approved by alice');
  });

  it('fails a raised budget when a bot applied loc-budget:override', () => {
    const base: LocBudget = { a: { source: 1, tests: 1 }, b: { source: 3, tests: 0 } };
    for (const [events, logins] of [
      [[label('x[bot]', 'Bot')], ''],
      [[label('svc')], 'svc'],
    ] as const) {
      const r = run(GUARD, { budget: MATCHING, base, events: [...events], env: { LOC_BUDGET_BOT_LOGINS: logins } });
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toContain('must be applied by a human');
    }
  });

  it('passes a budget lowered in the same PR without the override label', () => {
    const r = run(GUARD, { budget: MATCHING, base: lowerBase, events: 'throw' });
    expect(r.code).toBe(0);
  });

  it('raises nothing when the base has no loc-budget.json', () => {
    const r = run(GUARD, { budget: MATCHING, base: 'missing', events: [label('alice')] });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('raised a.source from none to 2');
  });

  it('fails instead of treating an unreachable base commit as an empty budget', () => {
    const r = run(GUARD, { budget: MATCHING, base: 'unreachable', events: [label('alice')] });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('bad revision');
  });

  it('fails when the head budget does not match the tree', () => {
    const r = run(GUARD, {
      budget: { ...MATCHING, b: { source: 1, tests: 0 } },
      base: lowerBase,
      events: [label('a')],
    });
    expect(r.code).toBe(1);
  });

  it('fails without GITHUB_REPOSITORY or when label events cannot be read', () => {
    const base: LocBudget = { a: { source: 1, tests: 1 }, b: { source: 3, tests: 0 } };
    expect(run(GUARD, { budget: MATCHING, base, env: { GITHUB_REPOSITORY: '' } }).code).toBe(1);
    expect(run(GUARD, { budget: MATCHING, base, events: 'throw' }).code).toBe(1);
  });
});
