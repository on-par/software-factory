import { expect, it, vi } from 'vitest';

import type { SandboxPolicy } from '@on-par/factory-core';
import { logSandboxPolicy } from './ship-steps.js';

it('retains runtime none for harnesses while --no-sandbox still disables it', () => {
  const policy: SandboxPolicy = {
    runtime: 'none',
    worktree: '/tmp/worktree',
    writablePaths: [],
    writableFilePrefixes: [],
    allowHosts: [],
    cpuMs: 300_000,
    memMb: 4096,
  };
  const log = vi.fn();
  expect(logSandboxPolicy({}, policy, log)).toBe(policy);
  expect(log).toHaveBeenCalledWith(
    'sandbox',
    'outer sandbox off; harness sandbox in use (codex --sandbox workspace-write; harnesses without their own sandbox run unwrapped)',
  );
  expect(log.mock.calls.flat().join(' ')).not.toContain('running uncontained');
  const consoleError = vi.spyOn(console, 'error').mockImplementationOnce(() => {});
  expect(logSandboxPolicy({ sandbox: false }, policy, vi.fn())).toBeUndefined();
  consoleError.mockRestore();
});
