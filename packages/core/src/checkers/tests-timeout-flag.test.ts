import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { CommandResult } from '../utils/command-runner.js';
import { BaselineCache } from './baseline-cache.js';
import { testsChecker } from './index.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

describe('testsChecker timeout flag (#3288)', () => {
  it('marks a timed-out tests run with timedOut: true so the baseline cache never stores it', async () => {
    const worktree = await tempDirs.make('tests-timeout-');
    await writeFile(join(worktree, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    const commandResult: CommandResult = {
      command: ['npm', 'test'],
      stdout: '',
      stderr: '',
      exitCode: -1,
      killed: true,
      timedOut: true,
      ok: false,
    };
    const runCommand = vi.fn(async () => commandResult);
    const output = await testsChecker({
      worktree,
      specPath: '',
      constitutionBody: '',
      testsTimeoutSeconds: 1,
      runCommand,
    });

    expect(output.result).toBe('FAIL');
    expect(output.timedOut).toBe(true);
    expect(output.details).toContain('timed out after 1s');

    const file = join(worktree, 'state', 'baseline-cache.json');
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [output]);
    expect(existsSync(file)).toBe(false);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();

    await cache.set('sha', 'env', 'cfg', [output, { checker: 'lint', result: 'FAIL', details: 'lint failed' }]);
    expect(JSON.parse(await readFile(file, 'utf-8')).entries['sha:env:tests']).toBeUndefined();
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toMatchObject({ result: 'FAIL' });
  });

  it('does not mark a non-timeout command failure', async () => {
    const worktree = await tempDirs.make('tests-failure-');
    await writeFile(join(worktree, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    const runCommand = vi.fn(async () => ({
      command: ['npm', 'test'],
      stdout: '',
      stderr: 'assertion failed',
      exitCode: 1,
      killed: false,
      timedOut: false,
      ok: false,
    }));
    const output = await testsChecker({ worktree, specPath: '', constitutionBody: '', runCommand });
    expect(output.result).toBe('FAIL');
    expect(output.timedOut).toBeUndefined();
  });

  it('preserves successful command output', async () => {
    const worktree = await tempDirs.make('tests-success-');
    await writeFile(join(worktree, 'package.json'), '{"scripts":{"test":"vitest run"}}');
    const runCommand = vi.fn(async () => ({
      command: ['npm', 'test'],
      stdout: '',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      ok: true,
    }));
    const output = await testsChecker({ worktree, specPath: '', constitutionBody: '', runCommand });
    expect(output).toMatchObject({ checker: 'tests', result: 'PASS' });
    expect(output.timedOut).toBeUndefined();
  });
});
