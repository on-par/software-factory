// packages/cli/src/cli/ship-sandbox-env.test.ts — ship-harness isolates an operator-exported FACTORY_SANDBOX_RUNTIME (#3244)
import { readFileSync } from 'node:fs';

import { afterAll, expect, it } from 'vitest';

import { h, installShipHarness, paths, shipIssue } from './test-support/ship-harness.js';

const originalSandboxRuntime = process.env.FACTORY_SANDBOX_RUNTIME;
process.env.FACTORY_SANDBOX_RUNTIME = 'none';

installShipHarness();

afterAll(() => {
  if (originalSandboxRuntime === undefined) delete process.env.FACTORY_SANDBOX_RUNTIME;
  else process.env.FACTORY_SANDBOX_RUNTIME = originalSandboxRuntime;
});

it('detects an available sandbox runtime despite an operator-exported runtime override', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  h.execSyncImpl = (cmd: string) => {
    if (cmd.includes('command -v firejail')) return '/usr/bin/firejail';
    throw new Error('not stubbed');
  };

  try {
    await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }

  const events = readFileSync(paths().events, 'utf-8');
  expect(events).toContain('sandbox-degraded');
  expect(events).not.toContain('sandbox-unavailable');
});
