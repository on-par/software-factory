import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CommandResult } from '../utils/command-runner.js';
import { createTempWorktrees } from '../test-support/temp-worktree.js';
import { inconclusiveOutputCause } from './inconclusive.js';
import { type CheckerContext, resolveTestsCommand, testsChecker } from './index.js';

const { makeWorktree, cleanup } = createTempWorktrees('verify-ps1-test-');
const PS1_ARGV = ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'scripts/verify.ps1'];

afterEach(async () => {
  await cleanup();
});

function makeContext(worktree: string): CheckerContext {
  return { worktree, specPath: join(worktree, 'no-such-spec.md'), constitutionBody: 'test constitution' };
}

function stubRunner(result: Partial<CommandResult>) {
  const calls: (readonly string[])[] = [];
  const run = async (argv: readonly string[]) => {
    calls.push(argv);
    return {
      command: argv,
      stdout: '',
      stderr: '',
      exitCode: 1,
      killed: false,
      timedOut: false,
      ok: false,
      ...result,
    };
  };
  return { run, calls };
}

async function pathWithPwsh(): Promise<string> {
  const dir = await makeWorktree({ pwsh: '#!/bin/sh\n' });
  await chmod(join(dir, 'pwsh'), 0o755);
  return dir;
}

describe('resolveTestsCommand', () => {
  it('resolveTestsCommand resolves scripts/verify.ps1 to pwsh when there is no scripts/verify.sh', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.ps1': 'exit 0' });
    expect(await resolveTestsCommand(makeContext(worktree))).toEqual({
      runner: 'verify-ps1',
      argv: PS1_ARGV,
      label: 'verify.ps1',
    });
  });

  it('resolveTestsCommand prefers scripts/verify.sh over scripts/verify.ps1', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.sh': '#!/bin/sh\n', 'scripts/verify.ps1': 'exit 0' });
    expect(await resolveTestsCommand(makeContext(worktree))).toEqual({
      runner: 'verify',
      argv: ['bash', 'scripts/verify.sh', '--no-e2e'],
      label: 'verify.sh',
    });
  });

  it('resolveTestsCommand prefers scripts/verify.ps1 over npm test', async () => {
    const worktree = await makeWorktree({
      'scripts/verify.ps1': 'exit 0',
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
    });
    expect((await resolveTestsCommand(makeContext(worktree))).runner).toBe('verify-ps1');
  });
});

describe('testsChecker with scripts/verify.ps1', () => {
  it('tests checker FAILs with verify.ps1 output when the script exits non-zero', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.ps1': 'exit 1' });
    const { run, calls } = stubRunner({ ok: false, exitCode: 1, stderr: 'Test failed: Foo.Bar' });
    const result = await testsChecker({
      ...makeContext(worktree),
      env: { PATH: await pathWithPwsh() },
      runCommand: run,
    });
    expect(result.result).toBe('FAIL');
    expect(result.details).toMatch(/^verify\.ps1 failed:/);
    expect(result.details).toContain('Test failed: Foo.Bar');
    expect(calls).toEqual([PS1_ARGV]);
  });

  it('tests checker PASSes when verify.ps1 exits zero', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.ps1': 'exit 0' });
    const { run } = stubRunner({ ok: true, exitCode: 0 });
    const result = await testsChecker({
      ...makeContext(worktree),
      env: { PATH: await pathWithPwsh() },
      runCommand: run,
    });
    expect(result).toMatchObject({ result: 'PASS', details: 'scripts/verify.ps1: OK' });
  });

  it('tests checker FAILs naming pwsh when pwsh is not on PATH, as command-not-found exit 127 that reads as inconclusive', async () => {
    const worktree = await makeWorktree({ 'scripts/verify.ps1': 'exit 0' });
    const { run, calls } = stubRunner({ ok: true, exitCode: 0 });
    const result = await testsChecker({
      ...makeContext(worktree),
      env: { PATH: await makeWorktree() },
      runCommand: run,
    });
    expect(result.result).toBe('FAIL');
    expect(result.details).toContain('pwsh');
    expect(calls).toEqual([]);
    expect(result.failedCommand?.exitCode).toBe(127);
    expect(inconclusiveOutputCause(result)).toBe('missing-command');
  });
});
