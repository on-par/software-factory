import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConstitutionLoader, REPO_INSTRUCTION_FILES, buildConstitutionContext } from './index.js';

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
