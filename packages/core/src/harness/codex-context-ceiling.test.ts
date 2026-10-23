import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { ModelsConfig } from '../config/index.js';
import { ModelRegistry } from '../models/index.js';
import { CodexCliHarness } from './codex-cli.js';
import {
  CODEX_COMPACT_PROMPT,
  DEFAULT_CODEX_CONTEXT_CEILING,
  resolveCodexContextCeiling,
} from './codex-context-ceiling.js';
import { makeContractRequest } from './contract.js';

const modelsConfig: ModelsConfig = {
  version: 1,
  models: {
    'codex-model': {
      provider: 'openai',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 272000,
      capabilities: [],
      envKey: null,
      codex: true,
    },
  },
  tiers: { boss: ['codex-model'] },
  failover: {
    triggers: ['rate_limit', 'unavailable', 'auth'],
    maxRetries: 2,
    cooldownMs: 0,
  },
  routingRules: {},
};
const registry = new ModelRegistry(modelsConfig);

interface Run {
  cmd: string;
  logs: string[];
  compactPath?: string;
  compactText?: string;
  compactExistedDuringExec: boolean;
}

async function runCodex(
  overrides: Parameters<typeof makeContractRequest>[0],
  opts: { throwInExec?: boolean } = {},
): Promise<Run> {
  const logs: string[] = [];
  const run: Run = { cmd: '', logs, compactExistedDuringExec: false };
  const harness = new CodexCliHarness(
    async (cmd) => {
      run.cmd = cmd;
      run.compactPath = cmd.match(/experimental_compact_prompt_file=([^' ]+)/)?.[1];
      if (run.compactPath !== undefined) {
        run.compactExistedDuringExec = existsSync(run.compactPath);
        run.compactText = await readFile(run.compactPath, 'utf-8');
      }
      if (opts.throwInExec) throw new Error('boom');
      await writeFile(cmd.match(/-o '([^']+)'/)![1], 'OUT');
      return { stdout: '', stderr: '' };
    },
    {},
    { log: (line) => logs.push(line) },
  );
  try {
    await harness.run(makeContractRequest({ model: 'codex-model', registry, ...overrides }));
  } catch {
    // exec failure is the point of one test
  }
  return run;
}

describe('CodexCliHarness context ceiling', () => {
  it('codex BUILD passes a 120K auto-compact limit and a handoff compact prompt', async () => {
    const run = await runCodex({ task: 'build_codex' });
    expect(run.cmd).toContain('model_auto_compact_token_limit=120000');
    expect(run.cmd).toContain('experimental_compact_prompt_file=');
    expect(run.cmd).toMatch(/ - < '[^']+'$/);
    expect(run.compactExistedDuringExec).toBe(true);
    expect(run.compactText).toBe(CODEX_COMPACT_PROMPT);
    expect(run.compactText).toContain('spec path');
    expect(run.compactText).toContain('git diff --stat');
    expect(existsSync(run.compactPath!)).toBe(false);
    expect(run.logs.filter((l) => l.includes('context ceiling'))).toEqual([
      'codex: context ceiling 120000 for build_codex',
    ]);
  });

  it('uses a custom ceiling', async () => {
    const run = await runCodex({ task: 'build_codex', contextCeiling: 90000 });
    expect(run.cmd).toContain('model_auto_compact_token_limit=90000');
  });

  it('contextCeiling 0 passes neither flag and logs off', async () => {
    const run = await runCodex({ task: 'build_codex', contextCeiling: 0 });
    expect(run.cmd).not.toContain('model_auto_compact_token_limit');
    expect(run.cmd).not.toContain('experimental_compact_prompt_file');
    expect(run.logs.some((l) => l.includes('context ceiling off ('))).toBe(true);
  });

  it('plan and judge tasks pass neither flag', async () => {
    for (const task of ['plan', 'review_pr'] as const) {
      const run = await runCodex({ task });
      expect(run.cmd).not.toContain('model_auto_compact_token_limit');
      expect(run.cmd).not.toContain('experimental_compact_prompt_file');
      expect(run.logs.some((l) => l.includes('context ceiling'))).toBe(false);
    }
  });

  it('a ceiling at or above the context window passes neither flag and logs why', async () => {
    for (const contextCeiling of [272000, 300000]) {
      const run = await runCodex({ task: 'build_codex', contextCeiling });
      expect(run.cmd).not.toContain('model_auto_compact_token_limit');
      expect(run.cmd).not.toContain('experimental_compact_prompt_file');
      expect(run.logs.some((l) => l.includes('>= context window 272000'))).toBe(true);
    }
  });

  it('removes the compact file when exec throws', async () => {
    const run = await runCodex({ task: 'build_codex' }, { throwInExec: true });
    expect(run.compactPath).toBeDefined();
    expect(existsSync(run.compactPath!)).toBe(false);
  });
});

describe('resolveCodexContextCeiling', () => {
  it('defaults to 120000', () => {
    expect(resolveCodexContextCeiling('build_codex', undefined, 272000)).toEqual({
      on: true,
      limit: DEFAULT_CODEX_CONTEXT_CEILING,
    });
  });

  it('is on without a known window', () => {
    expect(resolveCodexContextCeiling('build_claude', undefined, undefined)).toEqual({ on: true, limit: 120000 });
  });

  it('is off for 0', () => {
    expect(resolveCodexContextCeiling('build_codex', 0, 272000)).toEqual({ on: false, why: 'contextCeiling 0' });
  });

  it('is off for invalid values', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const result = resolveCodexContextCeiling('build_codex', bad, undefined);
      expect(result.on).toBe(false);
      expect(!result.on && result.why).toContain('invalid contextCeiling');
    }
  });

  it('is off when the ceiling equals the window', () => {
    expect(resolveCodexContextCeiling('build_codex', 272000, 272000)).toEqual({
      on: false,
      why: 'ceiling 272000 >= context window 272000',
    });
  });

  it('is off for non-build tasks', () => {
    expect(resolveCodexContextCeiling('plan', undefined, 272000)).toEqual({
      on: false,
      why: 'not an agentic build task',
    });
  });
});
