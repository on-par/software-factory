// packages/cli/src/cli/ship-codex-sandbox.test.ts — ship carries sandbox.codexSandbox onto the router (#3830)
import { describe, expect, it, vi } from 'vitest';

import { coreFakes, h, installShipHarness, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue codex sandbox (direct)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo });

  it('ship sets the router codex sandbox from config (#3830)', async () => {
    h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, codexSandbox: 'workspace-write' } };
    await shipIssue(5, {}, ctx());
    const router = vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value;
    expect(router.setCodexSandbox).toHaveBeenCalledWith('workspace-write');
  });
});
