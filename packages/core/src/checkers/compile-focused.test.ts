import { afterEach, describe, expect, it } from 'vitest';

import { recordingLog, type LoggedEvent } from '../test-support/recorders.js';
import { createTempWorktrees } from '../test-support/temp-worktree.js';
import type { CommandResult } from '../utils/command-runner.js';
import { compileChecker, type CheckerContext } from './index.js';

const { makeWorktree, cleanup } = createTempWorktrees('compile-focused-test-');
afterEach(cleanup);

describe('compileChecker focused typecheck (#4251)', () => {
  const focused = { argv: ['npx', 'tsc', '-b', '--incremental'], command: 'npx tsc -b --incremental' };
  const ctxWith = async (run: (argv: readonly string[]) => Promise<CommandResult>) => {
    const worktree = await makeWorktree();
    const logs: LoggedEvent[] = [];
    const ctx: CheckerContext = {
      worktree,
      specPath: `${worktree}/spec.md`,
      checks: { build: 'npm run build' },
      runCommand: run,
      log: recordingLog(logs),
      affectedTests: { kind: 'affected', argv: ['t'], command: 't', fileCount: 1, typecheck: focused, round: 2 },
    };
    return { ctx, logs };
  };
  const result = (ok: boolean, extra: Partial<CommandResult> = {}): CommandResult => ({
    command: [],
    ok,
    stdout: '',
    stderr: 'boom',
    exitCode: ok ? 0 : 2,
    killed: false,
    timedOut: false,
    ...extra,
  });

  it('compileChecker runs the focused typecheck when the selection carries one', async () => {
    const argvs: string[][] = [];
    const { ctx } = await ctxWith(async (argv) => {
      argvs.push([...argv]);
      return result(true);
    });
    const out = await compileChecker(ctx);
    expect(argvs).toEqual([focused.argv]);
    expect(out).toMatchObject({ result: 'PASS', details: 'focused typecheck: OK — npx tsc -b --incremental' });
  });

  it('compileChecker falls back to the full compile when the focused typecheck times out', async () => {
    const argvs: string[][] = [];
    const { ctx, logs } = await ctxWith(async (argv) => {
      argvs.push([...argv]);
      return argvs.length === 1 ? result(false, { timedOut: true }) : result(true);
    });
    const out = await compileChecker(ctx);
    expect(argvs).toEqual([focused.argv, ['npm', 'run', 'build']]);
    expect(out.result).toBe('PASS');
    expect(logs.map((l) => l.msg)).toContain('focused typecheck fell back to the full compile: timeout');
  });

  it('compileChecker falls back to the full compile when the focused typecheck cannot spawn', async () => {
    const argvs: string[][] = [];
    const { ctx, logs } = await ctxWith(async (argv) => {
      argvs.push([...argv]);
      if (argvs.length === 1) throw new Error('ENOENT');
      return result(true);
    });
    expect((await compileChecker(ctx)).result).toBe('PASS');
    expect(argvs[1]).toEqual(['npm', 'run', 'build']);
    expect(logs.map((l) => l.msg)).toContain('focused typecheck fell back to the full compile: tool-error');
  });

  it('compileChecker fails naming the focused command on a non-zero exit', async () => {
    const argvs: string[][] = [];
    const { ctx } = await ctxWith(async (argv) => {
      argvs.push([...argv]);
      return result(false);
    });
    const out = await compileChecker(ctx);
    expect(argvs).toEqual([focused.argv]);
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('npx tsc -b --incremental failed');
    expect(out.failedCommand).toMatchObject({ command: 'npx tsc -b --incremental', exitCode: 2 });
  });
});
