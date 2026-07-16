import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExecFn } from './exec.js';

describe('defaultExecFn', () => {
  it('resolves stdout for a quick command', async () => {
    const { stdout } = await defaultExecFn('echo hi', {});

    expect(stdout).toContain('hi');
  });

  it('passes timeoutMs through as a real kill timeout', async () => {
    const err: any = await defaultExecFn('sleep 2', { timeoutMs: 50 }).catch((e) => e);

    expect(err).toBeTruthy();
    expect(err.killed).toBe(true);
  });

  it('passes cwd through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exec-test-'));
    try {
      const realDir = await realpath(dir);
      const { stdout } = await defaultExecFn('pwd', { cwd: dir });

      expect(await realpath(stdout.trim())).toBe(realDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
