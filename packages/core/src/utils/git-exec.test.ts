import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { execGit, GIT_COMMAND_TIMEOUT_MS } from './git-exec.js';

describe('execGit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'git-exec-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves with stdout for a command that returns in time', async () => {
    const { stdout } = await execGit(['--version']);

    expect(stdout.trim()).toMatch(/^git version /);
  });

  it('runs in the given cwd', async () => {
    await execGit(['init', '-q'], { cwd: dir });

    const { stdout } = await execGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });

    expect(stdout.trim()).toBe('true');
  });

  it('passes each argument to git verbatim, with no shell interpretation', async () => {
    await execGit(['init', '-q'], { cwd: dir });
    const marker = join(dir, 'pwned');
    const hostile = `x; touch ${marker} $(touch ${marker}) \`touch ${marker}\``;

    await execGit(['config', 'user.name', hostile], { cwd: dir });
    const { stdout } = await execGit(['config', '--get', 'user.name'], { cwd: dir });

    expect(stdout.trim()).toBe(hostile);
    await expect(rm(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills the child and rejects with a named timeout error once the deadline passes', async () => {
    const started = Date.now();

    // `hash-object --stdin` waits on stdin forever (execFile leaves it open);
    // the assertion on elapsed time proves the child was killed, not awaited.
    const err: any = await execGit(['hash-object', '--stdin'], { timeoutMs: 50 }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GitTimeoutError');
    expect(err.message).toContain('timed out after 50ms');
    expect(err.message).toContain('git hash-object --stdin');
    expect(err.cmd).toBe('git hash-object --stdin');
    expect(err.timeoutMs).toBe(50);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('names the cwd in the timeout message when one was given', async () => {
    const err: any = await execGit(['hash-object', '--stdin'], { cwd: dir, timeoutMs: 50 }).catch((e) => e);

    expect(err.message).toContain(`(cwd ${dir})`);
    expect(err.cwd).toBe(dir);
  });

  it('passes an ordinary non-zero exit straight through, unwrapped', async () => {
    await execGit(['init', '-q'], { cwd: dir });

    const err: any = await execGit(['rev-parse', '--verify', '-q', 'refs/heads/missing'], { cwd: dir }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('GitTimeoutError');
    expect(err.code).toBe(1);
  });

  it('defaults to a ceiling generous enough for a real fetch but far below a CI job timeout', () => {
    expect(GIT_COMMAND_TIMEOUT_MS).toBe(120_000);
  });
});
