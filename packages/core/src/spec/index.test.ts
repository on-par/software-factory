// src/spec/index.test.ts — the frozen-spec module's interface: path derivation, the single
// route-normalization site, the artifact-set writer, and the archive rule (#666).

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { archiveSpec, parseSpec, readSpec, specPaths, stringifySpec, updateSpecRoute, writeSpec } from './index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-spec-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('specPaths', () => {
  it('derives all four artifact paths from the spec path, including md identity', () => {
    expect(specPaths('/x/plans/issue-N.md')).toEqual({
      md: '/x/plans/issue-N.md',
      designJson: '/x/plans/issue-N.design.json',
      designMd: '/x/plans/issue-N.design.md',
      adr: '/x/plans/issue-N.adr.json',
    });
  });
});

describe('parseSpec', () => {
  it.each([
    ['route: codex', 'codex'],
    ['route: "codex"', 'codex'],
    ['route:  codex ', 'codex'],
    ['route: claude', 'claude'],
    ['route: "claude"', 'claude'],
  ])('normalizes %s to route %s', (yaml, expected) => {
    const parsed = parseSpec(`---\n${yaml}\n---\n# Spec\n`);
    expect(parsed.route).toBe(expected);
    expect(parsed.data.route).toBe(expected);
  });

  it.each(['route: 123', 'route: gpt-5'])('returns null route for %s', (yaml) => {
    expect(parseSpec(`---\n${yaml}\n---\n# Spec\n`).route).toBeNull();
  });

  it('returns null route when the route key is missing', () => {
    const parsed = parseSpec('---\ndesign: present\n---\n# Spec\n');
    expect(parsed.route).toBeNull();
    expect(parsed.data).toEqual({ design: 'present' });
  });

  it('never throws on unparsable frontmatter and falls back to empty data and null route', () => {
    const content = '---\nroute: [unclosed\n---\n# Spec\n';
    const parsed = parseSpec(content);
    expect(parsed.data).toEqual({});
    expect(parsed.route).toBeNull();
    expect(parsed.body).toContain('# Spec');
  });

  it('parses a spec with no frontmatter into empty data, null route, and the whole content as body', () => {
    const content = '# Spec\n## Goal\nx\n';
    const parsed = parseSpec(content);
    expect(parsed.data).toEqual({});
    expect(parsed.route).toBeNull();
    expect(parsed.body).toContain('# Spec');
  });
});

describe('stringifySpec', () => {
  it('returns the body unchanged when data is empty', () => {
    expect(stringifySpec('# Spec\n', {})).toBe('# Spec\n');
  });

  it('serializes frontmatter when data has at least one key', () => {
    const out = stringifySpec('# Spec\n', { route: 'codex' });
    expect(out).toContain('route: codex');
    expect(out).toContain('# Spec');
  });
});

describe('readSpec / writeSpec', () => {
  it('rejects when readSpec targets a missing file', async () => {
    const dir = await tempDir();
    await expect(readSpec(join(dir, 'missing.md'))).rejects.toThrow();
  });

  it('round-trips body, data, and all three sidecars', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-1.md');
    await writeSpec(specPath, {
      body: '# Spec\n\nBody text.',
      data: { route: 'codex', design: { restatedProblem: 'p' } },
      designJson: JSON.stringify({ restatedProblem: 'p' }, null, 2),
      designMd: '## Design artifact (#1)',
      adrDrafts: JSON.stringify([{ title: 'Record ADR drafts', status: 'proposed' }], null, 2),
    });

    const parsed = await readSpec(specPath);
    expect(parsed.path).toBe(specPath);
    expect(parsed.route).toBe('codex');
    expect(parsed.data.route).toBe('codex');
    expect(parsed.data.design).toEqual({ restatedProblem: 'p' });
    expect(parsed.body).toContain('Body text.');

    const paths = specPaths(specPath);
    await expect(readFile(paths.designJson, 'utf-8')).resolves.toContain('restatedProblem');
    await expect(readFile(paths.designMd, 'utf-8')).resolves.toBe('## Design artifact (#1)');
    await expect(readFile(paths.adr, 'utf-8')).resolves.toContain('Record ADR drafts');
  });

  it('writes the body raw when data is absent or empty', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-2.md');
    await writeSpec(specPath, { body: '# Bare spec\n' });

    const parsed = await readSpec(specPath);
    expect(parsed.route).toBeNull();
    expect(parsed.body).toContain('# Bare spec');
  });

  it('writes sidecars only without touching the spec file', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-3.md');
    await writeFile(specPath, '---\nroute: claude\n---\n# Original\n');

    await writeSpec(specPath, { designMd: '## Design artifact (#3)' });

    await expect(readFile(specPath, 'utf-8')).resolves.toContain('route: claude');
    await expect(readFile(specPaths(specPath).designMd, 'utf-8')).resolves.toBe('## Design artifact (#3)');
    expect(existsSync(specPaths(specPath).designJson)).toBe(false);
    expect(existsSync(specPaths(specPath).adr)).toBe(false);
  });
});

describe('archiveSpec', () => {
  it('archives all four present files into .archive under a shared timestamp prefix', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-4.md');
    const paths = specPaths(specPath);
    await writeFile(specPath, '---\nroute: codex\n---\n# Spec\n');
    await writeFile(paths.designJson, '{}');
    await writeFile(paths.designMd, '## md');
    await writeFile(paths.adr, '[]');

    const archived = await archiveSpec(specPath);

    expect(archived).toHaveLength(4);
    const prefixes = archived.map((p) => basename(p).split('-')[0]);
    expect(new Set(prefixes).size).toBe(1);
    for (const file of ['issue-4.md', 'issue-4.design.json', 'issue-4.design.md', 'issue-4.adr.json']) {
      expect(existsSync(join(dir, '.archive', `${prefixes[0]}-${file}`))).toBe(true);
      expect(existsSync(join(dir, file))).toBe(false);
    }
  });

  it('returns [] when none of the four files exist', async () => {
    const dir = await tempDir();
    await expect(archiveSpec(join(dir, 'nothing.md'))).resolves.toEqual([]);
  });

  it('archives an orphaned sidecar even when the spec .md is missing', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-5.md');
    await writeFile(specPaths(specPath).adr, '[]');

    const archived = await archiveSpec(specPath);

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain('issue-5.adr.json');
    expect(existsSync(specPath)).toBe(false);
  });
});

describe('updateSpecRoute', () => {
  it('rewrites data.route while preserving the body and other frontmatter keys', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-6.md');
    await writeSpec(specPath, {
      body: '# Spec\n',
      data: { route: 'claude', design: { restatedProblem: 'p' } },
    });

    await updateSpecRoute(specPath, 'codex', 'local-only');

    const parsed = await readSpec(specPath);
    expect(parsed.route).toBe('codex');
    expect(parsed.data.design).toEqual({ restatedProblem: 'p' });
    expect(parsed.body).toContain('# Spec');
  });

  it('repairs a spec whose frontmatter is malformed instead of leaving it untouched', async () => {
    const dir = await tempDir();
    const specPath = join(dir, 'issue-7.md');
    await writeFile(specPath, '---\nroute: [unclosed\n---\n# Spec\n');

    await updateSpecRoute(specPath, 'claude', 'codex-disabled');

    const parsed = await readSpec(specPath);
    expect(parsed.route).toBe('claude');
    expect(parsed.body).toContain('# Spec');
  });
});
