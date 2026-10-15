// packages/cli/src/cli/status-config-label.test.ts — `factory status --kpis` names the loaded repo config file (#2570)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('status', () => {
    it('status --kpis names .factory/config.yaml as the repo config source when only config.yaml exists (#2570)', async () => {
      mkdirSync(join(h.repoRoot, '.factory'), { recursive: true });
      writeFileSync(join(h.repoRoot, '.factory', 'config.yaml'), 'providers:\n  ollama: false\n');
      await runMain('status', '--kpis');
      const out = logged();
      expect(out).toContain('(.factory/config.yaml)');
      expect(out).not.toContain('.factory/config.json');
    });

    it('status --kpis names the loaded repo config file for config.yml and config.json (#2570)', async () => {
      mkdirSync(join(h.repoRoot, '.factory'), { recursive: true });
      const yml = join(h.repoRoot, '.factory', 'config.yml');
      writeFileSync(yml, 'providers:\n  ollama: false\n');
      await runMain('status', '--kpis');
      expect(logged()).toContain('(.factory/config.yml)');

      rmSync(yml);
      writeFileSync(join(h.repoRoot, '.factory', 'config.json'), '{"providers":{"ollama":false}}');
      await runMain('status', '--kpis');
      expect(logged()).toContain('(.factory/config.json)');
    });
  });
});
