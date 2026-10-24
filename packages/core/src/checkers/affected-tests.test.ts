import { describe, expect, it } from 'vitest';

import { testsChecker, type CheckerContext } from './index.js';
import {
  describeAffectedResolution,
  listChangedFiles,
  MAX_AFFECTED_FILES,
  resolveAffectedTestsCommand,
  shellQuotePath,
  type AffectedTestsResolution,
} from './affected-tests.js';
import type { CommandResult } from '../utils/command-runner.js';

const repo = (fullOn?: string[]) => ({
  tests: { affected: { command: 'npx vitest related --run {files}', ...(fullOn ? { fullOn } : {}) } },
});
const resolve = (
  changedFiles: string[],
  fullOn?: string[],
  constitution = null as { affectedTestsFullOn: string[] } | null,
) => resolveAffectedTestsCommand({ repo: repo(fullOn), constitution, changedFiles });

describe('resolveAffectedTestsCommand quotes {files} and falls back on triggers', () => {
  it('expands {files} into quoted display text and raw argv', () => {
    expect(resolve(['src/my widget.ts'])).toMatchObject({
      kind: 'affected',
      command: "npx vitest related --run 'src/my widget.ts'",
      argv: ['npx', 'vitest', 'related', '--run', 'src/my widget.ts'],
    });
  });

  it('quotes an embedded single quote', () => {
    expect(shellQuotePath("it's.ts")).toBe(`'it'\\''s.ts'`);
    expect(resolve(["it's.ts"])).toMatchObject({ command: `npx vitest related --run 'it'\\''s.ts'` });
  });

  it.each([
    'pnpm-lock.yaml',
    'vitest.config.ts',
    '.github/workflows/ci.yml',
    'scripts/verify.sh',
    'db/migrations/001.sql',
    'packages/a/package.json',
    'tsconfig.build.json',
    'Package.json',
  ])('built-in trigger %s forces the full suite', (trigger) => {
    expect(resolve(['src/a.ts', trigger])).toMatchObject({ kind: 'full', reason: 'trigger', trigger });
  });

  it('honours fullOn and constitution affectedTestsFullOn globs', () => {
    expect(resolve(['infra/x.tf'], ['infra/**'])).toMatchObject({
      kind: 'full',
      reason: 'trigger',
      trigger: 'infra/x.tf',
    });
    expect(resolve(['a.proto'], undefined, { affectedTestsFullOn: ['*.proto'] })).toMatchObject({ kind: 'full' });
  });

  it('caps at 200 files', () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
    expect(resolve(files(MAX_AFFECTED_FILES + 1))).toMatchObject({ kind: 'full', reason: 'too-many-files' });
    expect(resolve(files(MAX_AFFECTED_FILES))).toMatchObject({ kind: 'affected' });
  });

  it('never treats snapshots as triggers', () => {
    expect(resolve(['__snapshots__/x.snap'])).toMatchObject({ kind: 'affected' });
    expect(resolve(['src/x.snap'])).toMatchObject({ kind: 'affected' });
  });

  it('reports not-configured and no-changed-files', () => {
    expect(resolveAffectedTestsCommand({ repo: {}, constitution: null, changedFiles: ['a.ts'] })).toMatchObject({
      reason: 'not-configured',
    });
    expect(resolve([])).toMatchObject({ reason: 'no-changed-files' });
  });
});

describe('listChangedFiles', () => {
  it('unions committed, uncommitted and untracked paths, sorted', async () => {
    const run = async (argv: readonly string[]) => {
      if (argv.some((a) => a.endsWith('...HEAD'))) return { ok: true, stdout: 'b.ts\n' };
      if (argv.includes('--others')) return { ok: true, stdout: 'c.ts\n' };
      return { ok: true, stdout: 'a.ts\nb.ts\n' };
    };
    expect(await listChangedFiles('/w', 'base', run)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns null when the base diff fails', async () => {
    expect(await listChangedFiles('/w', 'base', async () => ({ ok: false, stdout: '' }))).toBeNull();
  });
});

describe('describeAffectedResolution', () => {
  it('names reason and trigger', () => {
    expect(describeAffectedResolution({ kind: 'full', reason: 'trigger', trigger: 'a', fileCount: 2 }, 2)).toBe(
      'affected tests (round 2): full — trigger (a) (2 files)',
    );
  });
});

describe('testsChecker falls back to the full suite on zero tests or a tool error', () => {
  const selection: AffectedTestsResolution & { round: number } = {
    kind: 'affected',
    command: "npx vitest related --run 'a.ts'",
    argv: ['npx', 'vitest', 'related', '--run', 'a.ts'],
    fileCount: 1,
    round: 2,
  };
  const result = (ok: boolean, stdout: string, stderr = ''): CommandResult => ({
    command: [],
    ok,
    stdout,
    stderr,
    exitCode: ok ? 0 : 1,
    killed: false,
    timedOut: false,
  });

  function setup(affected: CheckerContext['affectedTests'], ...results: CommandResult[]) {
    const calls: string[][] = [];
    const logs: string[] = [];
    const ctx: CheckerContext = {
      worktree: '/w',
      specPath: '/s',
      checks: { test: 'npm test' },
      affectedTests: affected,
      runCommand: async (argv: readonly string[]) => {
        calls.push([...argv]);
        return results[calls.length - 1] ?? result(true, '');
      },
      log: (_t, m) => {
        logs.push(m);
      },
    };
    return { ctx, calls, logs };
  }

  it('exit 0 with zero tests runs full and uses its result', async () => {
    const { ctx, calls, logs } = setup(selection, result(true, ' Tests  0 passed (0)'), result(true, ''));
    const out = await testsChecker(ctx);
    expect(calls).toEqual([selection.argv, ['npm', 'test']]);
    expect(out).toMatchObject({ result: 'PASS', details: 'checks.test: OK' });
    expect(logs[0]).toContain('zero-tests');
  });

  it('exit 0 with no counts runs full', async () => {
    const { ctx, calls } = setup(selection, result(true, 'ok'), result(true, ''));
    await testsChecker(ctx);
    expect(calls).toHaveLength(2);
  });

  it('non-zero with no test evidence is a tool error and runs full', async () => {
    const { ctx, calls, logs } = setup(selection, result(false, 'No test files found'), result(true, ''));
    expect((await testsChecker(ctx)).result).toBe('PASS');
    expect(calls).toHaveLength(2);
    expect(logs[0]).toContain('tool-error');
  });

  it('a thrown spawn error runs full', async () => {
    const { ctx, calls } = setup(selection);
    ctx.runCommand = async (argv) => {
      calls.push([...argv]);
      if (calls.length === 1) throw new Error('ENOENT');
      return result(true, '');
    };
    expect((await testsChecker(ctx)).result).toBe('PASS');
    expect(calls).toHaveLength(2);
  });

  it('non-zero with failing-test evidence FAILs without a full run', async () => {
    const { ctx, calls } = setup(selection, result(false, ' FAIL  src/a.test.ts > adds\nAssertionError'));
    const out = await testsChecker(ctx);
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('affected failed');
    expect(calls).toHaveLength(1);
  });

  it('exit 0 with passing tests PASSes without a full run', async () => {
    const { ctx, calls } = setup(selection, result(true, ' Tests  3 passed (3)'));
    const out = await testsChecker(ctx);
    expect(out).toMatchObject({ result: 'PASS' });
    expect(out.details).toContain("npx vitest related --run 'a.ts'");
    expect(calls).toHaveLength(1);
  });

  it('runs only the full argv when affectedTests is unset', async () => {
    const { ctx, calls } = setup(undefined, result(true, ''));
    await testsChecker(ctx);
    expect(calls).toEqual([['npm', 'test']]);
  });
});
