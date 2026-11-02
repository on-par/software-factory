import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { listBuiltInCheckers } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CODE_FIXTURE,
  errored,
  h,
  installCliCommandsHarness,
  logged,
  paths,
  runMain,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('constitution', () => {
    it('scaffolds .factory/constitution.md with --init <product>, never touching getConstitutionsDir()', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      const before = readdirSync(h.constitutionsDir);
      const res = await runMain('constitution', '--init', 'gizmo');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().constitution)).toBe(true);
      expect(readFileSync(paths().constitution, 'utf-8')).toContain('product: "gizmo"');
      expect(readFileSync(paths().constitution, 'utf-8')).toContain('# Gizmo Constitution');
      // Regression (#1299): --init must never write into getConstitutionsDir().
      expect(readdirSync(h.constitutionsDir)).toEqual(before);
    });

    it('writes constitution to target repo when --init is given with no product', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      const before = readdirSync(h.constitutionsDir);
      const res = await runMain('constitution', '--init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().constitution)).toBe(true);
      expect(readFileSync(paths().constitution, 'utf-8')).toContain(basename(h.repoRoot));
      // Regression (#1299): --init must never write into getConstitutionsDir().
      expect(readdirSync(h.constitutionsDir)).toEqual(before);
    });

    it('creates .factory/ when missing before a bare --init', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      expect(existsSync(paths().root)).toBe(false);
      const res = await runMain('constitution', '--init');
      expect(res.exited).toBe(false);
      expect(existsSync(paths().root)).toBe(true);
      expect(existsSync(paths().constitution)).toBe(true);
    });

    it('refuses overwrite of an existing repo constitution without --force', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--init');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('existing content');
    });

    it('refuses overwrite of an existing repo constitution with a named --init', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--init', 'gizmo');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('existing content');
    });

    it('force overwrite replaces an existing repo constitution when --force is passed', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--init', '--force');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toContain(basename(h.repoRoot));
    });

    it('exits 2 when --init gets an invalid product name', async () => {
      const res = await runMain('constitution', '--init', '../evil');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid product name');
    });

    it('lists products with --list', async () => {
      await runMain('constitution', '--list');
      expect(logged()).toContain('alpha');
      expect(logged()).toContain('beta');
    });

    it('--list prints each product with its checkers', async () => {
      await runMain('constitution', '--list');
      expect(logged()).toContain('alpha — compile, lint');
      expect(logged()).toContain('beta — (no checkers)');
    });

    it('--checkers prints every built-in checker with a description', async () => {
      const res = await runMain('constitution', '--checkers');
      expect(res.exited).toBe(false);
      const out = logged();
      for (const c of listBuiltInCheckers()) expect(out).toContain(`${c.name} — ${c.description}`);
      expect(out).toContain('custom_<name>');
    });

    it('--product overwrites the unmodified init scaffold without --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      await runMain('init');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
    });

    it('--product overwrites the legacy template scaffold without --force', async () => {
      writeFileSync(
        join(h.constitutionsDir, '_template.md'),
        '```markdown\n---\nproduct: <product-name>\n---\n# <Product> Constitution\n```\n',
      );
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      await runMain('constitution', '--init');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
    });

    it('--product still refuses a user-edited constitution without --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'default-code.md'), DEFAULT_CODE_FIXTURE);
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      await runMain('init');
      appendFileSync(paths().constitution, '\nMy own rule.\n');
      const before = readFileSync(paths().constitution, 'utf-8');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe(before);
    });

    it('sets the active product when the constitution exists', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
      expect(logged()).toContain('Active product: alpha');
    });

    it('exits 1 for --product on a missing constitution', async () => {
      const res = await runMain('constitution', '--product', 'nope');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain("No constitution 'nope'");
      expect(errored()).toContain('Available products: alpha, beta');
      expect(existsSync(paths().constitution)).toBe(false);
      expect(existsSync(paths().product)).toBe(false);
    });

    it('copies the bundled markdown for --product into the repo constitution.md', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      const before = readdirSync(h.constitutionsDir);
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
      // --product must never write into getConstitutionsDir(), mirroring --init (#1299).
      expect(readdirSync(h.constitutionsDir)).toEqual(before);
    });

    it('refuses to overwrite an existing repo constitution.md with --product and no --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--product', 'alpha');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('already exists');
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('existing content');
      expect(existsSync(paths().product)).toBe(false);
    });

    it('overwrites an existing repo constitution.md with --product --force', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      writeFileSync(paths().constitution, 'existing content');
      const res = await runMain('constitution', '--product', 'alpha', '--force');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().constitution, 'utf-8')).toBe('# alpha constitution\n');
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');
    });

    it('overwrites .factory/state/product when --product is run again with a different name', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha constitution\n');
      writeFileSync(join(h.constitutionsDir, 'beta.md'), '# beta constitution\n');
      const first = await runMain('constitution', '--product', 'alpha');
      expect(first.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('alpha');

      const second = await runMain('constitution', '--product', 'beta', '--force');
      expect(second.exited).toBe(false);
      expect(readFileSync(paths().product, 'utf-8')).toBe('beta');
    });

    it('exits 2 with a usage line when no sub-option is given', async () => {
      const res = await runMain('constitution');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('usage: factory constitution');
    });

    it('rethrows an unexpected scaffolding error uncaught (not a CliExitError)', async () => {
      writeFileSync(join(h.constitutionsDir, '_template.md'), 'no markdown skeleton block here');
      await expect(runMain('constitution', '--init', 'gizmo')).rejects.toThrow(
        'constitution template is missing its ```markdown skeleton block',
      );
    });

    it('--help documents .factory/constitution.md as the source of truth and --product seeding', async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      const written: string[] = [];
      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('constitution', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('.factory/constitution.md in this repo is the source of truth');
      expect(text).toContain('Seed .factory/constitution.md from the bundled constitution for <name>');
    });
  });
});
