import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadModelsConfig } from './index.js';
import { applyRepoConfig, loadRepoConfig } from './repo.js';

const MODELS_DOC = fileURLToPath(new URL('../../../../docs/models.md', import.meta.url));

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('docs/models.md', () => {
  it('the Declaring a custom harness example loads as a .factory/config.yaml', () => {
    const doc = readFileSync(MODELS_DOC, 'utf8');
    const section = doc.slice(doc.indexOf('## Declaring a custom harness'));
    const block = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block).toBeDefined();

    const repoRoot = mkdtempSync(join(tmpdir(), 'factory-models-doc-'));
    tempDirs.push(repoRoot);
    mkdirSync(join(repoRoot, '.factory'));
    writeFileSync(join(repoRoot, '.factory', 'config.yaml'), block!);
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', undefined);

    const result = applyRepoConfig(loadModelsConfig(), loadRepoConfig(repoRoot));
    expect(result.harnesses?.['my-agent']).toBeDefined();
    expect(result.models['my-model'].harness).toBe('my-agent');
  });
});
