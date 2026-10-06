import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import type { CodexExecFn, CodexFsDeps } from './codex-cli.js';
import { CodexCliHarness } from './codex-cli.js';
import type { HarnessRequest } from './index.js';

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

function makeRequest(): HarnessRequest {
  return {
    model: 'codex-model',
    prompt: 'prompt',
    worktree: '/tmp/wt',
    timeoutSeconds: 5,
    task: 'build_codex',
    registry: new ModelRegistry(modelsConfig),
  };
}

function recordingFs() {
  const files = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  const unlinks: string[] = [];
  const fs: CodexFsDeps = {
    writeFile: async (path, data) => {
      writes.push([path, data]);
      files.set(path, data);
    },
    readFile: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    unlink: async (path) => {
      unlinks.push(path);
      files.delete(path);
    },
  };
  return { fs, files, writes, unlinks };
}

function writingExecFn(files: Map<string, string>): CodexExecFn {
  return async (cmd) => {
    const match = cmd.match(/-o '([^']+)'/);
    if (!match) throw new Error(`could not find outFile in cmd: ${cmd}`);
    files.set(match[1], 'codex output');
    return { stdout: '', stderr: '' };
  };
}

function expectUnlinkedNotZeroed(rec: ReturnType<typeof recordingFs>): void {
  expect(rec.unlinks).toEqual([expect.stringMatching(/factory-codex-/), expect.stringMatching(/factory-codex-out-/)]);
  expect(rec.unlinks[0]).not.toMatch(/factory-codex-out-/);

  const promptWriteIndex = rec.writes.findIndex(([, data]) => data === 'prompt');
  expect(promptWriteIndex).toBeGreaterThanOrEqual(0);
  expect(rec.writes.slice(promptWriteIndex + 1).some(([, data]) => data === '')).toBe(false);
}

describe('CodexCliHarness temp-file cleanup', () => {
  it('unlinks both temp files instead of zeroing them on success', async () => {
    const rec = recordingFs();
    const harness = new CodexCliHarness(writingExecFn(rec.files), rec.fs);

    const result = await harness.run(makeRequest());

    expect(result.output).toBe('codex output');
    expectUnlinkedNotZeroed(rec);
    expect(rec.files.size).toBe(0);
  });

  it('still unlinks both temp files when the exec fails', async () => {
    const rec = recordingFs();
    const harness = new CodexCliHarness(async () => {
      throw Object.assign(new Error('boom'), { stderr: 'x', code: 1 });
    }, rec.fs);

    await expect(harness.run(makeRequest())).rejects.toThrow();

    expectUnlinkedNotZeroed(rec);
  });

  it('creates the temp files through the injected writeFile', async () => {
    const rec = recordingFs();
    const harness = new CodexCliHarness(writingExecFn(rec.files), rec.fs);

    await harness.run(makeRequest());

    expect(rec.writes[0]).toEqual([expect.stringMatching(/factory-codex-/), '']);
    expect(rec.writes[1]).toEqual([expect.stringMatching(/factory-codex-out-/), '']);
  });
});
