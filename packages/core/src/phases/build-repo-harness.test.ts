import { workKeyFromIssue } from '../work/work-key.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadModelsConfig, loadRoutesConfig } from '../config/index.js';
import { applyRepoConfig, loadRepoConfig, resolveEffectiveModelPins } from '../config/repo.js';
import { ModelRegistry } from '../models/index.js';
import { CliModelExecutor, ModelRouter } from '../router/index.js';
import { buildPhase } from './build.js';

const CONFIG_YAML = `version: 2
harnesses:
  my-agent:
    command: my-agent {model}
    prompt: arg
    output: stdout
    agentic: true
    usage: none
models:
  registry:
    my-model:
      provider: custom
      tier: worker
      costPerMtokInput: 0
      costPerMtokOutput: 0
      contextWindow: 200000
      capabilities: [implementation]
      envKey: null
      harness: my-agent
  pins:
    build: my-model
`;

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildPhase with a harness declared in .factory/config.yaml', () => {
  it('runs the declared command with the BUILD prompt for a repo build pin', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'build-repo-harness-'));
    const worktree = mkdtempSync(join(tmpdir(), 'build-repo-harness-wt-'));
    tempDirs.push(repoRoot, worktree);
    mkdirSync(join(repoRoot, '.factory'));
    writeFileSync(join(repoRoot, '.factory', 'config.yaml'), CONFIG_YAML);
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', undefined);
    vi.stubEnv('FACTORY_BUILD_MODEL', undefined);

    const repo = loadRepoConfig(repoRoot);
    const models = applyRepoConfig(loadModelsConfig(), repo);
    const pins = resolveEffectiveModelPins(new ModelRegistry(models), repo, {});
    expect(pins.build).toBe('my-model');

    const calls: { cmd: string }[] = [];
    const exec = async (cmd: string) => {
      calls.push({ cmd });
      return { stdout: 'done', stderr: '' };
    };

    const result = await buildPhase({
      issue: workKeyFromIssue(2866),
      repo: 'o/r',
      worktree,
      specPath: join(worktree, 'issue-2866.md'),
      branch: 'ship-it/2866-repo-harness',
      route: 'command',
      router: new ModelRouter(models, loadRoutesConfig(), false, new CliModelExecutor(exec)),
      constitution: null,
      log: () => {},
      modelOverride: pins.build,
    });

    expect(result.ok).toBe(true);
    expect(calls[0].cmd).toMatch(/^my-agent /);
    expect(calls[0].cmd).toContain('Implement issue #2866');
  });
});
