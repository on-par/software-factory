// The per-language starter configs in docs/ must load as real repo configs, so they cannot drift from the schema.

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import { loadRepoConfig } from './repo.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

describe('docs/config.example.<language>.yaml', () => {
  for (const language of ['dotnet', 'node', 'python']) {
    it(`${language} loads and declares build, test and lint checks`, () => {
      const root = tmp.makeSync(`example-${language}-`);
      mkdirSync(join(root, '.factory'));
      copyFileSync(
        fileURLToPath(new URL(`../../../../docs/config.example.${language}.yaml`, import.meta.url)),
        join(root, '.factory', 'config.yaml'),
      );
      const config = loadRepoConfig(root);
      expect(Object.keys(config?.checks ?? {}).sort()).toEqual(['build', 'lint', 'test']);
    });
  }
});
