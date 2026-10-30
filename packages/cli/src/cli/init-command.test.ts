import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import { buildInitConfig, formatInitReachability } from './index.js';
import {
  coreFakes,
  DEFAULT_CODE_FIXTURE,
  errored,
  h,
  installCliCommandsHarness,
  logged,
  ops,
  paths,
  runMain,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('init', () => {
    beforeEach(() => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
    });

    it("scaffolds the active product's bundled constitution when state/product names one", async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      mkdirSync(dirname(paths().product), { recursive: true });
      writeFileSync(paths().product, 'alpha');
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
    });

    it('ends with a Next hint that recommends factory doctor, then factory triage, with --product optional', async () => {
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain(
        'Next: factory doctor, then factory triage (optional: factory constitution --product <name> to swap the default constitution)',
      );
      expect(out).not.toContain('Next: factory constitution --product <name>, then factory triage');
      expect(out.trimEnd().split('\n').at(-1)).toMatch(/^Next: factory doctor, then factory triage/);
    });

    it('does not run `ollama list` when ollama is not on PATH', async () => {
      coreFakes.isCommandAvailable.mockImplementation((c: string) => c !== 'ollama');
      const cmds: string[] = [];
      const prev = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => {
        cmds.push(cmd);
        if (cmd === 'ollama list') throw new Error('/bin/sh: 1: ollama: not found');
        return prev(cmd);
      };
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(cmds).not.toContain('ollama list');
      for (const text of [logged(), errored()]) {
        expect(text).not.toMatch(/\/bin\/sh/);
        expect(text).not.toMatch(/not found/);
        expect(text).not.toMatch(/ollama/i);
      }
    });

    it('runs `ollama list` unchanged when ollama is on PATH', async () => {
      const prev = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => (cmd === 'ollama list' ? 'NAME ID SIZE MODIFIED\n' : prev(cmd));
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(ops.execSync).toHaveBeenCalledWith('ollama list', { timeout: 10_000 });
      const out = logged();
      expect(out).toContain('policy=auto');
      expect(out).toContain('Initialized');
      expect(out).toContain('Next: factory doctor');
    });

    it('creates .factory dirs and a sample queue without git-excluding .factory/ (#3689)', async () => {
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().queue)).toBe(true);
      expect(existsSync(join(h.repoRoot, '.git/info/exclude'))).toBe(false);
      expect(logged()).toContain('Initialized');
    });

    it('drops a legacy .factory/ exclude line and does not clobber an existing queue', async () => {
      writeFileSync(join(h.repoRoot, '.git/info/exclude'), '*.swp\n.factory/\n');
      writeFileSync(paths().queue, 'app 1\n');
      await runMain('init');
      expect(readFileSync(join(h.repoRoot, '.git/info/exclude'), 'utf-8')).toBe('*.swp\n');
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 1\n');
    });

    it('warns with the missing-token message but still initializes when no token source is available', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) throw new Error('not authenticated');
        return '';
      };
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('factory: warning: GITHUB_TOKEN not set — create a token at');
      expect(existsSync(paths().queue)).toBe(true);
      expect(logged()).toContain('Initialized');
    });

    it('succeeds when GH_TOKEN is set even without GITHUB_TOKEN', async () => {
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'test-token';
      const res = await runMain('init');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Initialized');
    });

    it('writes config.yaml, constitution.md, and .gitignore, then prints a reachability summary', async () => {
      h.diagnoses = [
        { reachable: true, tiers: ['worker'] } as any,
        { reachable: true, tiers: ['worker'] } as any,
        { reachable: false, tiers: ['worker'] } as any,
      ];
      const res = await runMain('init');
      expect(res.exited).toBe(false);

      const yamlConfig = join(h.repoRoot, '.factory', 'config.yaml');
      expect(existsSync(yamlConfig)).toBe(true);
      const text = readFileSync(yamlConfig, 'utf-8');
      expect(text.startsWith('#')).toBe(true);
      expect(text).toContain('version: 2');

      expect(existsSync(paths().constitution)).toBe(true);
      const constitution = readFileSync(paths().constitution, 'utf-8');
      expect(constitution).toBe(DEFAULT_CODE_FIXTURE);

      expect(existsSync(paths().gitignore)).toBe(true);
      expect(readFileSync(paths().gitignore, 'utf-8')).toContain('state/');

      expect(logged()).toContain('policy=auto,');
      expect(logged()).toContain('models reachable');
    });

    it('is idempotent: a second run without --force leaves an existing config untouched', async () => {
      const sentinel = '{"version":2,"models":{"pins":{"plan":"x"}}}';
      writeFileSync(paths().config, sentinel);
      await runMain('init');
      expect(readFileSync(paths().config, 'utf-8')).toBe(sentinel);
      expect(logged()).toContain('leaving as-is');
    });

    it('--force overwrites an existing config', async () => {
      writeFileSync(paths().config, '{"version":2,"models":{"pins":{"plan":"x"}}}');
      await runMain('init', '--force');
      expect(readFileSync(paths().config, 'utf-8')).toBe(buildInitConfig('json'));
    });

    it('leaves .factory/ git-clean except the committed config, constitution, .gitignore, and the state/ directory', async () => {
      await runMain('init');
      writeFileSync(paths().queue, 'app 1\n');

      expect(readdirSync(paths().root).sort()).toEqual(
        ['.gitignore', 'config.yaml', 'constitution.md', 'state'].sort(),
      );
    });
  });

  describe('buildInitConfig', () => {
    it('defaults to a YAML header comment plus version: 2', () => {
      const text = buildInitConfig();
      expect(text.startsWith('#')).toBe(true);
      expect(text).toContain('version: 2\n');
    });

    it('returns valid pin-free version-2 JSON for json', () => {
      const parsed = JSON.parse(buildInitConfig('json'));
      expect(parsed).toEqual({ version: 2 });
      expect(parsed.models).toBeUndefined();
      expect(parsed.tiers).toBeUndefined();
    });
  });

  describe('formatInitReachability', () => {
    it('renders policy=auto, K/N models reachable', () => {
      const diagnoses = [{ reachable: true } as any, { reachable: true } as any, { reachable: false } as any];
      expect(formatInitReachability(diagnoses)).toBe('policy=auto, 2/3 models reachable');
    });
  });

  describe('formatInitReachability unverified', () => {
    it('counts reachable models and reports unverified ones separately', () => {
      const diagnoses = [
        { reachable: true } as any,
        { reachable: false, unverified: true } as any,
        { reachable: false } as any,
      ];
      expect(formatInitReachability(diagnoses)).toBe(
        'policy=auto, 1/3 models reachable, 1 unverified (no auth evidence)',
      );
    });
  });
});
