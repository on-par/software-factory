// packages/cli/src/cli/status-codex-sandbox.test.ts — status carries sandbox.codexSandbox onto the router (#3830)
import { describe, expect, it } from 'vitest';

import { coreFakes, h, installShipHarness, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('status codex sandbox', () => {
  it('status sets the router codex sandbox from config (#3830)', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, codexSandbox: 'workspace-write' } };
    const sandboxes: unknown[] = [];
    const base = coreFakes.ModelRouter;
    coreFakes.ModelRouter = function () {
      return Object.assign(new base(), { setCodexSandbox: (s: unknown) => void sandboxes.push(s) });
    } as typeof base;
    await runMainWith(undefined, 'status');
    expect(sandboxes).toEqual(['workspace-write']);
  });
});
