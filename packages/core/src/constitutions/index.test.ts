import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import {
  buildConstitutionContext,
  ConstitutionLoader,
  DEFAULT_REPO_CONSTITUTION_PATH,
  DEFAULT_REVIEW_CONSTITUTION,
  describeConstitutionSource,
  REPO_INSTRUCTION_FILES,
} from './index.js';

const BUNDLED = `---
product: acme-app
version: 2
checkers:
  - compile
  - custom_a11y
---

# Acme Constitution

Bundled standards body.
`;

describe('ConstitutionLoader repo-first resolution', () => {
  let bundledDir: string;
  let repoDir: string;
  let loader: ConstitutionLoader;

  beforeEach(async () => {
    bundledDir = await mkdtemp(join(tmpdir(), 'constitutions-'));
    repoDir = await mkdtemp(join(tmpdir(), 'repo-'));
    loader = new ConstitutionLoader(bundledDir);
  });

  afterEach(async () => {
    await rm(bundledDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('exposes the instruction-file priority order', () => {
    expect(REPO_INSTRUCTION_FILES).toEqual(['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md']);
  });

  it('resolves standards from a repo CLAUDE.md', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), '# House rules\nAlways TDD.');

    const c = loader.resolve(repoDir);
    expect(c).not.toBeNull();
    expect(c!.source).toBe('repo');
    expect(c!.body).toContain('Always TDD.');
    expect(c!.body).toContain('CLAUDE.md');
    expect(c!.checkers).toEqual([]);
  });

  it('concatenates multiple instruction files in priority order with attribution', async () => {
    await writeFile(join(repoDir, 'AGENTS.md'), 'agents rules');
    await mkdir(join(repoDir, '.github'), { recursive: true });
    await writeFile(join(repoDir, '.github', 'copilot-instructions.md'), 'copilot rules');
    await writeFile(join(repoDir, 'CLAUDE.md'), 'claude rules');

    const c = loader.resolve(repoDir)!;
    const claudeIdx = c.body.indexOf('claude rules');
    const agentsIdx = c.body.indexOf('agents rules');
    const copilotIdx = c.body.indexOf('copilot rules');

    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(claudeIdx).toBeLessThan(agentsIdx);
    expect(agentsIdx).toBeLessThan(copilotIdx);
    // each section attributed to its source file
    expect(c.body).toContain('CLAUDE.md');
    expect(c.body).toContain('AGENTS.md');
    expect(c.body).toContain('.github/copilot-instructions.md');
  });

  it('repo instruction files lead, with the configured constitution riding along', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    await writeFile(join(repoDir, 'AGENTS.md'), 'repo wins');

    const c = loader.resolve(repoDir, 'acme-app')!;
    expect(c.source).toBe('repo');
    // explicitly configured checkers must not be silently dropped, and the
    // standards that define them must stay in the body they are graded against
    expect(c.checkers).toEqual(['compile', 'custom_a11y']);
    expect(c.body.indexOf('repo wins')).toBeGreaterThanOrEqual(0);
    expect(c.body.indexOf('repo wins')).toBeLessThan(c.body.indexOf('Bundled standards body.'));
    expect(c.body).toContain('<standards source="constitution:acme-app">');
  });

  it('does not append an empty bundled body when merging', async () => {
    await writeFile(join(bundledDir, 'bare.md'), '---\nproduct: bare\ncheckers:\n  - custom_x\n---\n');
    await writeFile(join(repoDir, 'CLAUDE.md'), 'repo rules');

    const c = loader.resolve(repoDir, 'bare')!;
    expect(c.checkers).toEqual(['custom_x']);
    expect(c.body).not.toContain('constitution:bare');
  });

  it('falls back to the bundled constitution when the repo has no instruction files', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);

    const c = loader.resolve(repoDir, 'acme-app')!;
    expect(c.source).toBe('bundled');
    expect(c.body).toContain('Bundled standards body.');
    expect(c.checkers).toEqual(['compile', 'custom_a11y']);
  });

  it('load() parses requireTests: true from frontmatter and defaults to false when absent', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    await writeFile(
      join(bundledDir, 'strict-app.md'),
      '---\nproduct: strict-app\nrequireTests: true\n---\nStrict body.\n',
    );

    expect(loader.load('acme-app').requireTests).toBe(false);
    expect(loader.load('strict-app').requireTests).toBe(true);
  });

  it('parses only literal true as the evidence-plan opt-out and carries it through merged resolution', async () => {
    await writeFile(join(bundledDir, 'disabled.md'), '---\nproduct: disabled\ndisableEvidencePlan: true\n---\n');
    await writeFile(join(bundledDir, 'enabled.md'), '---\nproduct: enabled\ndisableEvidencePlan: "true"\n---\n');
    await writeFile(join(repoDir, 'AGENTS.md'), 'repo instructions');
    expect(loader.load('disabled').disableEvidencePlan).toBe(true);
    expect(loader.load('enabled').disableEvidencePlan).toBe(false);
    expect(loader.resolve(repoDir, 'disabled')?.disableEvidencePlan).toBe(true);
  });

  it('resolve() preserves the bundled requireTests flag when merging with repo instruction files', async () => {
    await writeFile(
      join(bundledDir, 'strict-app.md'),
      '---\nproduct: strict-app\nrequireTests: true\n---\nStrict body.\n',
    );
    await writeFile(join(repoDir, 'CLAUDE.md'), 'repo wins');

    const c = loader.resolve(repoDir, 'strict-app')!;
    expect(c.source).toBe('repo');
    expect(c.requireTests).toBe(true);
  });

  it('resolve() with only repo instruction files yields requireTests: false', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), 'repo only');

    const c = loader.resolve(repoDir)!;
    expect(c.requireTests).toBe(false);
  });

  it('returns null when nothing is configured and the repo has no instruction files', () => {
    expect(loader.resolve(repoDir)).toBeNull();
  });

  it('fails fast on a configured product with no bundled constitution', async () => {
    // a typo'd --product must halt the run, not silently drop all standards
    expect(() => loader.resolve(repoDir, 'no-such-product')).toThrow(/No constitution for 'no-such-product'/);

    await writeFile(join(repoDir, 'CLAUDE.md'), 'repo rules');
    expect(() => loader.resolve(repoDir, 'no-such-product')).toThrow(/No constitution for 'no-such-product'/);
  });

  it('skips unreadable instruction entries (e.g. a directory named AGENTS.md)', async () => {
    await mkdir(join(repoDir, 'AGENTS.md'));
    expect(loader.resolve(repoDir)).toBeNull();

    await writeFile(join(repoDir, 'CLAUDE.md'), 'still resolves');
    expect(loader.resolve(repoDir)!.body).toContain('still resolves');
  });

  it('ignores empty instruction files', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), '   \n');
    expect(loader.resolve(repoDir)).toBeNull();
  });

  it('listProducts() lists bundled product names, filtering non-md, underscore-prefixed, and review-only files', async () => {
    await writeFile(join(bundledDir, 'example-alpha.md'), '# Alpha');
    await writeFile(join(bundledDir, 'example-beta.md'), '# Beta');
    await writeFile(join(bundledDir, '_template.md'), '# Template');
    await writeFile(join(bundledDir, 'notes.txt'), 'not a constitution');
    await writeFile(join(bundledDir, `${DEFAULT_REVIEW_CONSTITUTION}.md`), '# Review only');

    expect(loader.listProducts()).toEqual(['example-alpha', 'example-beta']);
  });

  it('defaults to the real bundled constitutions dir when constructed with no argument', () => {
    const defaultLoader = new ConstitutionLoader();
    const products = defaultLoader.listProducts();

    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.startsWith('example-') || p === 'default-code')).toBe(true);
    expect(products).toContain('default-code');
    expect(products).not.toContain('acme-cli');
    expect(products).not.toContain(DEFAULT_REVIEW_CONSTITUTION);
    expect(products).not.toContain('_template');
  });

  it('ships a default-code constitution with only built-in checkers', () => {
    const c = new ConstitutionLoader().load('default-code');
    expect(c.checkers).toEqual(['worker_output', 'compile', 'tests', 'lint', 'design_smells']);
    expect(c.checkers.some((n) => n.startsWith('custom_'))).toBe(false);
  });

  it('falls back to the filename-derived product when frontmatter omits product', async () => {
    await writeFile(join(bundledDir, 'noname.md'), '---\nversion: 3\n---\nBody.\n');

    const c = loader.load('noname');
    expect(c.product).toBe('noname');
    expect(c.version).toBe(3);
  });

  describe('loadRepoConstitution', () => {
    it('returns null when the repo has no constitution instance', () => {
      expect(loader.loadRepoConstitution(repoDir)).toBeNull();
    });

    it('returns null for an empty constitution instance', async () => {
      await mkdir(join(repoDir, '.factory'), { recursive: true });
      await writeFile(join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH), '   \n');
      expect(loader.loadRepoConstitution(repoDir)).toBeNull();
    });

    it('parses product/checkers/requireTests/body from .factory/constitution.md', async () => {
      await mkdir(join(repoDir, '.factory'), { recursive: true });
      await writeFile(
        join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH),
        '---\nproduct: consumer-app\nrequireTests: true\ncheckers:\n  - compile\n---\nConsumer body.\n',
      );

      const c = loader.loadRepoConstitution(repoDir)!;
      expect(c.product).toBe('consumer-app');
      expect(c.requireTests).toBe(true);
      expect(c.checkers).toEqual(['compile']);
      expect(c.body).toContain('Consumer body.');
      expect(c.source).toBe('bundled');
    });

    it('honors a non-default relPath argument', async () => {
      await writeFile(join(repoDir, 'custom-constitution.md'), '---\nproduct: custom\n---\nCustom body.\n');
      const c = loader.loadRepoConstitution(repoDir, 'custom-constitution.md')!;
      expect(c.product).toBe('custom');
      expect(c.body).toContain('Custom body.');
    });
  });

  describe('resolve() with a repo constitution instance', () => {
    it('yields source: bundled with the instance checkers and body when no other product is configured', async () => {
      await mkdir(join(repoDir, '.factory'), { recursive: true });
      await writeFile(
        join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH),
        '---\nproduct: consumer-app\ncheckers:\n  - compile\n---\nConsumer body.\n',
      );

      const c = loader.resolve(repoDir)!;
      expect(c.source).toBe('bundled');
      expect(c.checkers).toEqual(['compile']);
      expect(c.body).toContain('Consumer body.');
    });

    it('prefers the repo instance over a --product package file when both exist', async () => {
      await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
      await mkdir(join(repoDir, '.factory'), { recursive: true });
      await writeFile(
        join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH),
        '---\nproduct: consumer-app\ncheckers:\n  - custom_x\n---\nConsumer wins.\n',
      );

      const c = loader.resolve(repoDir, 'acme-app')!;
      expect(c.source).toBe('bundled');
      expect(c.product).toBe('consumer-app');
      expect(c.checkers).toEqual(['custom_x']);
      expect(c.body).toContain('Consumer wins.');
    });

    it('honors a non-default constitutionPath argument', async () => {
      await writeFile(join(repoDir, 'custom-constitution.md'), '---\nproduct: custom\n---\nCustom body.\n');
      const c = loader.resolve(repoDir, undefined, 'custom-constitution.md')!;
      expect(c.product).toBe('custom');
      expect(c.body).toContain('Custom body.');
    });

    it('repo instruction files lead with the repo constitution checkers riding along', async () => {
      await mkdir(join(repoDir, '.factory'), { recursive: true });
      await writeFile(
        join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH),
        '---\nproduct: consumer-app\ncheckers:\n  - compile\n---\nConsumer body.\n',
      );
      await writeFile(join(repoDir, 'CLAUDE.md'), 'repo instructions win');

      const c = loader.resolve(repoDir)!;
      expect(c.source).toBe('repo');
      expect(c.checkers).toEqual(['compile']);
      expect(c.body.indexOf('repo instructions win')).toBeGreaterThanOrEqual(0);
      expect(c.body).toContain('<standards source="constitution:consumer-app">');
      expect(c.body).toContain('Consumer body.');
    });

    it('still fails fast on a typo product when no repo constitution instance exists', () => {
      expect(() => loader.resolve(repoDir, 'no-such-product')).toThrow(/No constitution for 'no-such-product'/);
    });
  });

  describe('resolve() main checkout fallback', () => {
    let mainDir: string;

    beforeEach(async () => {
      mainDir = await mkdtemp(join(tmpdir(), 'main-'));
      await mkdir(join(mainDir, '.factory'), { recursive: true });
      await writeFile(
        join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH),
        '---\nproduct: main-instance\ncheckers: [main_check]\n---\nMain checkout standards.',
      );
    });

    afterEach(async () => {
      await rm(mainDir, { recursive: true, force: true });
    });

    it('prefers the main checkout constitution over the bundled product file when the worktree has none', async () => {
      await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);

      const c = loader.resolve(repoDir, 'acme-app', undefined, mainDir);
      expect(c).not.toBeNull();
      expect(c!.body).toContain('Main checkout standards.');
      expect(c!.body).not.toContain('Bundled standards body.');
      expect(c!.path).toBe(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH));
      expect(c!.checkers).toEqual(['main_check']);
    });

    it('returns the main checkout constitution instead of null when no product is active', () => {
      const c = loader.resolve(repoDir, undefined, undefined, mainDir);
      expect(c).not.toBeNull();
      expect(c!.body).toContain('Main checkout standards.');
      expect(c!.path).toBe(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH));
      expect(loader.resolve(repoDir)).toBeNull();
    });

    const writeWorktreeInstance = async () => {
      await mkdir(join(repoDir, '.factory'), { recursive: true });
      await writeFile(join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH), '---\nproduct: wt\n---\nWorktree standards.');
    };

    it('loads the main checkout constitution over a worktree-authored one and the bundled product', async () => {
      await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
      await writeWorktreeInstance();

      const c = loader.resolve(repoDir, 'acme-app', undefined, mainDir);
      expect(c!.body).toContain('Main checkout standards.');
      expect(c!.body).not.toContain('Worktree standards.');
      expect(c!.body).not.toContain('Bundled standards body.');
      expect(c!.path).toBe(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH));
      expect(c!.checkers).toEqual(['main_check']);
    });

    it('with no product, loads the main checkout constitution even when the worktree has its own', async () => {
      await writeWorktreeInstance();

      const c = loader.resolve(repoDir, undefined, undefined, mainDir);
      expect(c!.body).toContain('Main checkout standards.');
      expect(c!.body).not.toContain('Worktree standards.');
      expect(c!.path).toBe(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH));
    });

    it('ignores a worktree-authored constitution and falls back to the bundled product when the main checkout has none', async () => {
      await rm(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH));
      await writeWorktreeInstance();
      await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);

      const c = loader.resolve(repoDir, 'acme-app', undefined, mainDir);
      expect(c!.body).toContain('Bundled standards body.');
      expect(c!.body).not.toContain('Worktree standards.');
      expect(loader.resolve(repoDir, undefined, undefined, mainDir)).toBeNull();
    });

    it('ignores a worktree .factory/constitution.md and sets repoInstance to the main-checkout path', async () => {
      await writeWorktreeInstance();

      const c = loader.resolve(repoDir, undefined, undefined, mainDir);
      expect(c!.body).toContain('Main checkout standards.');
      expect(c!.repoInstance).toEqual({
        relPath: DEFAULT_REPO_CONSTITUTION_PATH,
        absPath: join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH),
      });
      expect(c!.repoInstance!.absPath).not.toBe(join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH));
    });

    it('without a main checkout, still reads the repoDir instance', async () => {
      await writeWorktreeInstance();

      const c = loader.resolve(repoDir);
      expect(c!.body).toContain('Worktree standards.');
      expect(c!.path).toBe(join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH));
    });

    it('falls through an empty main checkout file to the bundled product', async () => {
      await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
      await writeFile(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH), '   \n');

      const c = loader.resolve(repoDir, 'acme-app', undefined, mainDir);
      expect(c!.body).toContain('Bundled standards body.');
    });
  });
});

describe('describeConstitutionSource', () => {
  let mainDir: string;
  let worktree: string;
  let bundledDir: string;
  let loader: ConstitutionLoader;

  beforeEach(async () => {
    mainDir = await mkdtemp(join(tmpdir(), 'dcs-main-'));
    worktree = await mkdtemp(join(tmpdir(), 'dcs-wt-'));
    bundledDir = await mkdtemp(join(tmpdir(), 'dcs-bundled-'));
    loader = new ConstitutionLoader(bundledDir);
    await mkdir(join(mainDir, '.factory'), { recursive: true });
    await writeFile(join(mainDir, DEFAULT_REPO_CONSTITUTION_PATH), '---\nproduct: inst\n---\nInstance standards.');
  });

  afterEach(async () => {
    await Promise.all([mainDir, worktree, bundledDir].map((d) => rm(d, { recursive: true, force: true })));
  });

  it('describes a null constitution', () => {
    expect(describeConstitutionSource(null)).toBe(
      'No standards found (no repo instruction files, no constitution) — proceeding without',
    );
  });

  it('names .factory/constitution.md and its absolute path for a main-checkout instance with an empty worktree', () => {
    const c = loader.resolve(worktree, undefined, undefined, mainDir);
    expect(describeConstitutionSource(c)).toBe(
      `Standards from .factory/constitution.md (${join(mainDir, '.factory/constitution.md')})`,
    );
  });

  it('adds the merged repo instruction files after the instance', async () => {
    await writeFile(join(worktree, 'CLAUDE.md'), 'Repo rules.');
    const c = loader.resolve(worktree, undefined, undefined, mainDir);
    expect(describeConstitutionSource(c)).toBe(
      `Standards from .factory/constitution.md (${join(mainDir, '.factory/constitution.md')}), plus repo instruction files (CLAUDE.md)`,
    );
  });

  it('keeps the legacy text for repo files without an instance', async () => {
    await writeFile(join(worktree, 'CLAUDE.md'), 'Repo rules.');
    const c = loader.resolve(worktree);
    expect(describeConstitutionSource(c)).toBe('Standards from repo instruction files');
    expect(describeConstitutionSource(c, 'acme')).toBe(
      "Standards from repo instruction files (custom checkers from 'acme')",
    );
  });

  it('names the product and absolute path for a package-bundled fallback', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    const c = loader.resolve(worktree, 'acme-app');
    expect(describeConstitutionSource(c, 'acme-app')).toBe(
      `Standards from bundled constitution 'acme-app' (${join(bundledDir, 'acme-app.md')})`,
    );
  });
});

describe('buildConstitutionContext', () => {
  let bundledDir: string;
  let repoDir: string;
  let loader: ConstitutionLoader;

  beforeEach(async () => {
    bundledDir = await mkdtemp(join(tmpdir(), 'constitutions-'));
    repoDir = await mkdtemp(join(tmpdir(), 'repo-'));
    loader = new ConstitutionLoader(bundledDir);
  });

  afterEach(async () => {
    await rm(bundledDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('is empty for null', () => {
    expect(buildConstitutionContext(null)).toBe('');
  });

  it('is empty for a frontmatter-only constitution (no prose to enforce)', async () => {
    await writeFile(join(bundledDir, 'bare.md'), '---\nproduct: bare\ncheckers:\n  - custom_x\n---\n');
    expect(buildConstitutionContext(loader.resolve(repoDir, 'bare'))).toBe('');
  });

  it('wraps repo standards and names the instruction files', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), 'context body here');
    const ctx = buildConstitutionContext(loader.resolve(repoDir));
    expect(ctx).toContain('context body here');
    expect(ctx).toContain('instruction files');
    expect(ctx).not.toContain('Dispute Rules');
  });

  it('wraps bundled standards and keeps the Dispute Rules pointer', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    const ctx = buildConstitutionContext(loader.resolve(repoDir, 'acme-app'));
    expect(ctx).toContain('Bundled standards body.');
    expect(ctx).toContain('Dispute Rules');
  });

  it('does not re-load by frontmatter product name (filename/frontmatter mismatch is safe)', async () => {
    // frontmatter product differs from the filename — building context from the
    // resolved object must not re-resolve `Acme App.md` and throw
    await writeFile(join(bundledDir, 'foo.md'), BUNDLED.replace('product: acme-app', 'product: Acme App'));
    const c = loader.resolve(repoDir, 'foo');
    expect(c!.product).toBe('Acme App');
    expect(() => buildConstitutionContext(c)).not.toThrow();
    expect(buildConstitutionContext(c)).toContain('Bundled standards body.');
  });
});

describe('buildConstitutionContext omitSources (#1600)', () => {
  const tmp = createTempDirs();
  let repoDir: string;
  beforeEach(async () => {
    repoDir = await tmp.make('constitution-omit-');
  });
  afterEach(() => tmp.cleanup());
  const write = async (name: string, mark: string) =>
    writeFile(join(repoDir, name), `# ${name}\n\n## Rules\n\n- ${mark}\n`);

  it('swaps only the AGENTS.md block for a pointer', async () => {
    await write('CLAUDE.md', 'CLAUDE-MARK-1600');
    await write('AGENTS.md', 'AGENTS-MARK-1600');
    const c = new ConstitutionLoader().loadFromRepo(repoDir);
    for (const view of ['full', 'standards'] as const) {
      const out = buildConstitutionContext(c, view, { omitSources: ['AGENTS.md'] });
      expect(out).not.toContain('AGENTS-MARK-1600');
      expect(out).toContain('CLAUDE-MARK-1600');
      expect(out).toContain('<standards source="AGENTS.md">');
      expect(out).toContain('AGENTS.md is loaded automatically by your agent harness');
    }
  });

  it('is unchanged without options or with an empty list', async () => {
    await write('CLAUDE.md', 'CLAUDE-MARK-1600');
    await write('AGENTS.md', 'AGENTS-MARK-1600');
    const c = new ConstitutionLoader().loadFromRepo(repoDir);
    const base = buildConstitutionContext(c, 'standards');
    expect(buildConstitutionContext(c, 'standards', {})).toBe(base);
    expect(buildConstitutionContext(c, 'standards', { omitSources: [] })).toBe(base);
    expect(base).toContain('AGENTS-MARK-1600');
  });

  it('stays non-empty when AGENTS.md is the only file', async () => {
    await write('AGENTS.md', 'AGENTS-MARK-1600');
    const c = new ConstitutionLoader().loadFromRepo(repoDir);
    const out = buildConstitutionContext(c, 'standards', { omitSources: ['AGENTS.md'] });
    expect(out).toContain('It is binding.');
    expect(out).not.toContain('AGENTS-MARK-1600');
  });

  it('leaves an unterminated block alone', () => {
    const c = { source: 'repo', product: 'x', body: '<standards source="AGENTS.md">\n\nAGENTS-MARK-1600' } as never;
    expect(buildConstitutionContext(c, 'full', { omitSources: ['AGENTS.md'] })).toContain('AGENTS-MARK-1600');
  });
});
