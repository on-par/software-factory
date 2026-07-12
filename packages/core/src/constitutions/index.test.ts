import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConstitutionLoader, REPO_INSTRUCTION_FILES } from './index.js';

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
    expect(REPO_INSTRUCTION_FILES).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      '.github/copilot-instructions.md',
    ]);
  });

  it('resolves standards from a repo CLAUDE.md with default (no custom) checkers', async () => {
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

  it('prefers repo instruction files over a bundled constitution', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    await writeFile(join(repoDir, 'AGENTS.md'), 'repo wins');

    const c = loader.resolve(repoDir, 'acme-app')!;
    expect(c.source).toBe('repo');
    expect(c.body).toContain('repo wins');
    expect(c.body).not.toContain('Bundled standards body.');
  });

  it('falls back to the bundled constitution when the repo has no instruction files', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);

    const c = loader.resolve(repoDir, 'acme-app')!;
    expect(c.source).toBe('bundled');
    expect(c.body).toContain('Bundled standards body.');
    expect(c.checkers).toEqual(['compile', 'custom_a11y']);
  });

  it('returns null when nothing is found, without throwing on a missing bundled product', () => {
    expect(loader.resolve(repoDir)).toBeNull();
    expect(loader.resolve(repoDir, 'no-such-product')).toBeNull();
  });

  it('buildContextFor wraps repo standards and is empty when nothing is found', async () => {
    expect(loader.buildContextFor(repoDir)).toBe('');

    await writeFile(join(repoDir, 'CLAUDE.md'), 'context body here');
    const ctx = loader.buildContextFor(repoDir);
    expect(ctx).toContain('context body here');
    expect(ctx).toContain('instruction files');
  });

  it('buildContextFor falls back to the bundled wrapper unchanged', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    const ctx = loader.buildContextFor(repoDir, 'acme-app');
    expect(ctx).toContain('Bundled standards body.');
    expect(ctx).toBe(loader.buildContext('acme-app'));
  });

  it('getCheckersFor returns bundled custom checkers only on fallback', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), BUNDLED);
    expect(loader.getCheckersFor(repoDir, 'acme-app')).toEqual(['compile', 'custom_a11y']);

    await writeFile(join(repoDir, 'CLAUDE.md'), 'repo rules');
    expect(loader.getCheckersFor(repoDir, 'acme-app')).toEqual([]);
    expect(loader.getCheckersFor(repoDir)).toEqual([]);
  });

  it('getBodyFor mirrors resolve', async () => {
    expect(loader.getBodyFor(repoDir)).toBe('');
    await writeFile(join(repoDir, 'CLAUDE.md'), 'body via getBodyFor');
    expect(loader.getBodyFor(repoDir)).toContain('body via getBodyFor');
  });

  it('ignores empty instruction files', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), '   \n');
    expect(loader.resolve(repoDir)).toBeNull();
  });
});
