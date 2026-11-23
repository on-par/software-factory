import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadModelsConfig, loadRoutesConfig, type ModelsConfig } from '../config/index.js';
import { applyRepoConfig, type RepoFactoryConfig } from '../config/repo.js';
import type { CodingHarness } from '../harness/index.js';
import { runReadinessGate } from '../phases/plan-readiness.js';
import { CliModelExecutor, ModelRouter } from './index.js';
import { resetOllamaProbeCache } from './ollama-probe.js';

const VERDICT = JSON.stringify({ schemaVersion: 1, verdict: 'ready', summary: 'ok', assumptions: [], questions: [] });
const BRIEF = '## Problem statement\nFix it.\n## Acceptance criteria\n- [ ] fixed';

function recordingFetch() {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ message: { content: VERDICT } }),
    };
  };
  return { urls, fetchFn };
}

const fakeHarness = (id: string): CodingHarness => ({ id, agentic: false, run: async () => ({ output: VERDICT }) });

function setup(models: ModelsConfig = loadModelsConfig(), localOnly = false) {
  const { urls, fetchFn } = recordingFetch();
  const executor = new CliModelExecutor(async () => ({ stdout: '', stderr: '' }), fetchFn, {
    'claude-cli': fakeHarness('claude-cli'),
    'codex-cli': fakeHarness('codex-cli'),
  });
  const router = new ModelRouter(models, loadRoutesConfig(), false, executor, false, localOnly);
  return { urls, router };
}

const judge = (router: ModelRouter) =>
  runReadinessGate({
    mode: 'advisory',
    work: { title: 'Fix it', brief: BRIEF },
    router,
    worktree: tmpdir(),
    log: () => {},
  });

const judgeModel = (gate: Awaited<ReturnType<typeof judge>>) =>
  gate.kind === 'proceed' ? gate.readiness.judge?.model : undefined;

describe('local model provider probing is opt-in', () => {
  beforeEach(() => {
    resetOllamaProbeCache();
    vi.stubEnv('OLLAMA_BASE_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('opens no local provider connection from the plan readiness judge without local provider config', async () => {
    const { urls, router } = setup();

    const gate = await judge(router);

    expect(urls).toEqual([]);
    expect(judgeModel(gate)).toBe('claude-haiku-5-5');
  });

  it('opens no local provider connection from any tier routed without local provider config', async () => {
    const { urls, router } = setup();

    for (const task of ['triage', 'readiness_judge', 'classify_pr'] as const) {
      await router.run(task, 'p', { worktree: tmpdir() });
    }

    expect(urls).toEqual([]);
  });

  it('probes the endpoint named by OLLAMA_BASE_URL', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://10.1.2.3:11434');
    const { urls, router } = setup();

    const gate = await judge(router);

    expect(urls[0]).toBe('http://10.1.2.3:11434/api/version');
    expect(judgeModel(gate)).toBe('qwen2.5-coder:14b');
  });

  it('probes the default local endpoint when the repo config pins an Ollama model', async () => {
    const repo: RepoFactoryConfig = { version: 2, models: { pins: { triage: 'qwen2.5-coder:14b' } } };
    const { urls, router } = setup(applyRepoConfig(loadModelsConfig(), repo));

    const gate = await judge(router);

    expect(urls[0]).toBe('http://127.0.0.1:11434/api/version');
    expect(judgeModel(gate)).toBe('qwen2.5-coder:14b');
  });

  it('probes the default local endpoint in local-only mode', async () => {
    const { urls, router } = setup(loadModelsConfig(), true);

    const gate = await judge(router);

    expect(urls[0]).toBe('http://127.0.0.1:11434/api/version');
    expect(judgeModel(gate)).toBe('qwen2.5-coder:14b');
  });
});
