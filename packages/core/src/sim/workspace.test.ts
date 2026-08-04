import { exec as execCb } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createSimWorkspace } from './workspace.js';

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
});
