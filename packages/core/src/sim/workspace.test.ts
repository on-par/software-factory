import { exec as execCb } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createSimWorkspace, simCommitAll } from './workspace.js';

const exec = promisify(execCb);

describe('createSimWorkspace', () => {
  it('creates a bare origin with a main branch, a clone, and an empty plans dir', async () => {
    const ws = await createSimWorkspace();
    try {
      expect(ws.origin.startsWith(realpathSync(tmpdir()))).toBe(true);
      await expect(exec(`git -C '${ws.origin}' rev-parse --verify refs/heads/main`)).resolves.toBeTruthy();

      const readme = await readFile(`${ws.repoRoot}/README.md`, 'utf-8');
      expect(readme).toBe('# Throwaway\n');

      expect(existsSync(ws.plansDir)).toBe(true);
    } finally {
      await ws.dispose();
    }
  });

  it('dispose removes origin, repoRoot, and the plans dir, and is safe to call twice', async () => {
    const ws = await createSimWorkspace();
    expect(existsSync(ws.origin)).toBe(true);
    expect(existsSync(ws.repoRoot)).toBe(true);
    expect(existsSync(ws.plansDir)).toBe(true);

    await ws.dispose();
    expect(existsSync(ws.origin)).toBe(false);
    expect(existsSync(ws.repoRoot)).toBe(false);
    expect(existsSync(ws.plansDir)).toBe(false);

    await expect(ws.dispose()).resolves.toBeUndefined();
  });

  it('simCommitAll shell-escapes a commit message containing a single quote', async () => {
    const ws = await createSimWorkspace();
    try {
      await writeFile(`${ws.repoRoot}/quoted.txt`, 'content\n');
      await simCommitAll(ws.repoRoot, "fix: don't break on quotes");
      const { stdout } = await exec('git log -1 --format=%s', { cwd: ws.repoRoot });
      expect(stdout.trim()).toBe("fix: don't break on quotes");
    } finally {
      await ws.dispose();
    }
  });
});
