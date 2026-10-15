// packages/cli/src/cli/scaffold-template.test.ts — the bundled _template.md scaffold is valid unedited (#2973, #2974)
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConstitutionLoader, getConstitutionsDir } from '@on-par/factory-core';
import { findUnknownConstitutionCheckers } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { scaffoldConstitution } from './index.js';

function frontmatterLines(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '---');
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === '---');
  return end < 0 ? [] : lines.slice(start + 1, end);
}

function stripComment(line: string): string {
  return line.trim().startsWith('#') ? '' : line.replace(/\s+#.*$/, '');
}

describe('scaffoldConstitution on the bundled template', () => {
  it('scaffoldConstitution on the bundled _template.md lists only known checkers and no live <...> placeholder', async () => {
    const template = readFileSync(join(getConstitutionsDir(), '_template.md'), 'utf-8');
    const scaffold = scaffoldConstitution(template, 'acme-app');
    const dir = await mkdtemp(join(tmpdir(), 'factory-scaffold-'));
    try {
      await mkdir(join(dir, '.factory'), { recursive: true });
      await writeFile(join(dir, '.factory', 'constitution.md'), scaffold);
      const constitution = new ConstitutionLoader().loadRepoConstitution(dir);
      expect(constitution).not.toBeNull();
      expect(constitution?.checkers.length).toBeGreaterThan(0);
      expect(findUnknownConstitutionCheckers(constitution?.checkers ?? [], scaffold)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const lines = scaffold.split('\n');
    const start = lines.findIndex((l) => l.trim() === 'checkers:');
    expect(start).toBeGreaterThanOrEqual(0);
    const block: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!/^\s+(-|#)/.test(line)) break;
      block.push(line);
    }
    expect(block.length).toBeGreaterThan(0);
    expect(block.filter((l) => /^\s*-\s*</.test(l))).toEqual([]);
  });

  it('scaffoldConstitution on the bundled _template.md leaves no <...> token in the frontmatter outside comments', () => {
    const template = readFileSync(join(getConstitutionsDir(), '_template.md'), 'utf-8');
    const scaffold = scaffoldConstitution(template, 'acme-app');
    const frontmatter = frontmatterLines(scaffold);
    expect(frontmatter.length).toBeGreaterThan(0);
    expect(frontmatter).toContain('product: "acme-app"');
    expect(frontmatter.map(stripComment).filter((l) => /<[^>]+>/.test(l))).toEqual([]);

    const skeleton = /```markdown\n([\s\S]*?)```/.exec(template)?.[1] ?? '';
    const tokens = frontmatterLines(skeleton)
      .map(stripComment)
      .flatMap((l) => l.match(/<[^>]+>/g) ?? []);
    expect([...new Set(tokens)]).toEqual(['<product-name>']);
  });
});
