import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor } from './index.js';

vi.mock('node:child_process', () => ({
  exec: (_cmd: string, _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }),
}));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    unlink: vi.fn(actual.unlink),
  };
});

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'codex-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
  },
  tiers: { boss: ['codex-model'] },
  failover: {
    triggers: ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response'],
    maxRetries: 2,
    cooldownMs: 0,
    escalateAfterTierExhausted: true,
  },
  routingRules: {},
};

const routesConfig: RoutesConfig = {
  version: 1,
  routes: {
    build_codex: { tier: 'boss', description: 'stub', requires: 'codex' },
  },
};

describe('CliModelExecutor Codex cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unlinks codex temp files instead of zeroing them during cleanup', async () => {
    const registry = new ModelRegistry(modelsConfig);
    const executor = new CliModelExecutor();

    await executor.runModel('codex-model', 'prompt', {
      worktree: tmpdir(),
      timeout: 5,
      task: 'build_codex',
      registry,
      routesConfig,
    });

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(vi.mocked(unlink).mock.calls).toEqual([
      [expect.stringMatching(/factory-codex-/)],
      [expect.stringMatching(/factory-codex-out-/)],
    ]);

    const promptWriteIndex = vi.mocked(writeFile).mock.calls.findIndex(([, data]) => data === 'prompt');
    expect(promptWriteIndex).toBeGreaterThanOrEqual(0);
    expect(
      vi.mocked(writeFile).mock.calls
        .slice(promptWriteIndex + 1)
        .some(([, data]) => data === ''),
    ).toBe(false);
  });
});
