// packages/cli/src/cli/status-codex-sandbox.test.ts — status carries sandbox.codexSandbox onto the router (#3830)
import { describe, expect, it, vi } from 'vitest';

import { coreFakes, h, installShipHarness, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('status codex sandbox', () => {
  it('status sets the router codex sandbox from config (#3830)', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, codexSandbox: 'workspace-write' } };
    await runMainWith(undefined, 'status');
    const router = vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value;
    expect(router.setCodexSandbox).toHaveBeenCalledWith('workspace-write');
  });
});
