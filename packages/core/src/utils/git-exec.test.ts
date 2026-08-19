import { describe, expect, it } from 'vitest';

import { execGit, GIT_COMMAND_TIMEOUT_MS } from './git-exec.js';

describe('execGit', () => {
  it('resolves with stdout for a command that returns in time', async () => {
    const { stdout } = await execGit('echo hello');

    expect(stdout.trim()).toBe('hello');
  });

  it('runs in the given cwd', async () => {
    const { stdout } = await execGit('pwd', { cwd: '/' });

    expect(stdout.trim()).toBe('/');
  });

  it('kills the child and rejects with a named timeout error once the deadline passes', async () => {
    const started = Date.now();

    // Would hang for 30s without the deadline; the assertion on elapsed time is
    // what proves the child was actually killed rather than merely awaited.
    const err: any = await execGit('sleep 30', { timeoutMs: 50 }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GitTimeoutError');
    expect(err.message).toContain('timed out after 50ms');
    expect(err.message).toContain('sleep 30');
    expect(err.timeoutMs).toBe(50);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('names the cwd in the timeout message when one was given', async () => {
    const err: any = await execGit('sleep 30', { cwd: '/', timeoutMs: 50 }).catch((e) => e);

    expect(err.message).toContain('(cwd /)');
    expect(err.cwd).toBe('/');
  });

  it('passes an ordinary non-zero exit straight through, unwrapped', async () => {
    const err: any = await execGit('exit 3').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('GitTimeoutError');
    expect(err.code).toBe(3);
  });

  it('defaults to a ceiling generous enough for a real fetch but far below a CI job timeout', () => {
    expect(GIT_COMMAND_TIMEOUT_MS).toBe(120_000);
  });
});
