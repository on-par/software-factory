import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterError } from './checkpoint.js';
import { commitCheckpoint, createExecaExec, prepareWorkspace, type ExecFn } from './workspace.js';

function fakeExec(): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (argv) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('prepareWorkspace', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scbench-workspace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('initializes git and .factory dirs on a fresh workspace', async () => {
    const { exec, calls } = fakeExec();

    await prepareWorkspace(dir, { exec });

    expect(calls[0]).toEqual(['git', 'init']);
    expect(calls[1]).toEqual(['git', 'add', '-A']);
    expect(calls[2]).toContain('commit');
    expect(existsSync(join(dir, '.factory'))).toBe(true);
    expect(existsSync(join(dir, '.factory', 'logs'))).toBe(true);
    expect(existsSync(join(dir, '.factory', 'plans'))).toBe(true);
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.factory/');
  });

  it('does not re-init git when .git already exists (idempotent)', async () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    const { exec, calls } = fakeExec();

    await prepareWorkspace(dir, { exec });

    expect(calls).toEqual([]);
    expect(existsSync(join(dir, '.factory'))).toBe(true);
  });

  it('does not duplicate the exclude entry on a second run', async () => {
    const { exec } = fakeExec();
    await prepareWorkspace(dir, { exec });
    await prepareWorkspace(dir, { exec });

    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.match(/\.factory\//g)?.length).toBe(1);
  });

  it('propagates a non-ENOENT error reading the exclude file (e.g. it is a directory)', async () => {
    mkdirSync(join(dir, '.git', 'info', 'exclude'), { recursive: true });
    const { exec } = fakeExec();

    await expect(prepareWorkspace(dir, { exec })).rejects.toThrow(/EISDIR|illegal operation/i);
  });

  it('preserves existing exclude entries and appends a trailing newline', async () => {
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'node_modules/');
    const { exec } = fakeExec();

    await prepareWorkspace(dir, { exec });

    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toBe('node_modules/\n.factory/\n');
  });
});

describe('commitCheckpoint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scbench-workspace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds and commits with the checkpoint id in the message', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await commitCheckpoint(dir, '3', { exec });

    expect(calls[0]).toEqual(['git', 'add', '-A']);
    expect(calls[1]).toContain('scbench: checkpoint 3');
  });

  it('tolerates "nothing to commit"', async () => {
    const exec: ExecFn = async (argv) => {
      if (argv.includes('commit')) return { exitCode: 1, stdout: 'nothing to commit, working tree clean', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await expect(commitCheckpoint(dir, '3', { exec })).resolves.toBeUndefined();
  });

  it('throws AdapterError on any other git failure', async () => {
    const exec: ExecFn = async (argv) => {
      if (argv.includes('commit')) return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await expect(commitCheckpoint(dir, '3', { exec })).rejects.toThrow(AdapterError);
  });
});

describe('createExecaExec', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scbench-workspace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a real command and reports its exit code without throwing', async () => {
    const exec = createExecaExec();

    const ok = await exec([process.execPath, '-e', 'process.stdout.write("hi")'], { cwd: dir });
    expect(ok).toEqual({ exitCode: 0, stdout: 'hi', stderr: '' });

    const failed = await exec([process.execPath, '-e', 'process.exit(3)'], { cwd: dir });
    expect(failed.exitCode).toBe(3);
  });
});
