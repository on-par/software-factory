import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyRepoConfig,
  loadModelsConfig,
  loadRepoConfig,
  ModelRegistry,
  routeForBuildModel,
} from '@on-par/factory-core';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RENDER = join(HERE, 'render-config.sh');

const render = (agent: string) => spawnSync('bash', [RENDER, agent], { encoding: 'utf8' });

describe.skipIf(process.platform === 'win32')('smoke-repo fixture', () => {
  it('ships a tiny source tree and a factory config template', () => {
    for (const file of [
      'README.md',
      'package.json',
      'src/greet.mjs',
      'test/greet-check.mjs',
      'factory-config.template.yaml',
      'render-config.sh',
    ])
      expect(existsSync(join(HERE, file)), file).toBe(true);
    const tpl = spawnSync('grep', ['-c', '__SMOKE_AGENT__', join(HERE, 'factory-config.template.yaml')], {
      encoding: 'utf8',
    });
    expect(tpl.status).toBe(0);
    const check = spawnSync('node', ['test/greet-check.mjs'], { cwd: HERE, encoding: 'utf8' });
    expect(check.status).toBe(0);
  });

  it.each([
    ['codex', 'codex-cli', 'codex'],
    ['opencode', 'opencode', 'opencode'],
    ['command', 'command', undefined],
  ])('renders a config that pins every phase to the %s smoke model', (agent, harness, route) => {
    const res = render(agent);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('__SMOKE_AGENT__');

    const savedRunConfig = process.env.FACTORY_RUN_CONFIG_JSON;
    delete process.env.FACTORY_RUN_CONFIG_JSON;
    const dir = mkdtempSync(join(tmpdir(), 'smoke-repo-'));
    try {
      mkdirSync(join(dir, '.factory'));
      writeFileSync(join(dir, '.factory', 'config.yaml'), res.stdout);
      const repo = loadRepoConfig(dir);
      if (repo?.version !== 2) throw new Error('expected a version 2 config');
      const pins = repo.models?.pins;
      const id = `smoke-${agent}`;
      expect([pins?.plan, pins?.build, pins?.checker, pins?.triage]).toEqual([id, id, id, id]);
      const applied = applyRepoConfig(loadModelsConfig(), repo);
      expect(applied.models[id]?.harness).toBe(harness);
      expect(routeForBuildModel(new ModelRegistry(applied), pins?.build)).toBe(route);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (savedRunConfig === undefined) delete process.env.FACTORY_RUN_CONFIG_JSON;
      else process.env.FACTORY_RUN_CONFIG_JSON = savedRunConfig;
    }
  });

  it.each(['', 'claude', 'CODEX', 'codex;rm'])('rejects agent %j with exit 2', (agent) => {
    const res = render(agent);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('usage:');
  });
});
