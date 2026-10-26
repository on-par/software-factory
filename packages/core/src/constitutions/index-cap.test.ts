import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { buildConstitutionContext, CONSTITUTION_MAX_BYTES, ConstitutionLoader } from './index.js';

function bodyOf(ctx: string): string {
  return ctx.slice(ctx.indexOf('\n\n') + 2, ctx.indexOf('\n\n</constitution>'));
}

const tempDirs = createTempDirs();

describe('buildConstitutionContext cap and standards view (#1599)', () => {
  let bundledDir: string;
  let repoDir: string;
  let loader: ConstitutionLoader;

  beforeEach(async () => {
    bundledDir = await tempDirs.make('constitutions-');
    repoDir = await tempDirs.make('repo-');
    loader = new ConstitutionLoader(bundledDir);
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it('caps a 20 KB constitution at 8 KB and ends the body with a truncation marker naming the cut file', async () => {
    const filler = '- rule line\n'.repeat(560);
    await mkdir(join(repoDir, '.github'));
    await writeFile(join(repoDir, 'CLAUDE.md'), filler);
    await writeFile(join(repoDir, 'AGENTS.md'), filler);
    await writeFile(join(repoDir, '.github', 'copilot-instructions.md'), filler);
    const ctx = buildConstitutionContext(loader.resolve(repoDir));
    expect(Buffer.byteLength(ctx, 'utf8')).toBeLessThanOrEqual(CONSTITUTION_MAX_BYTES);
    expect(bodyOf(ctx)).toMatch(/\n\n\[truncated — see AGENTS\.md\]$/);
  });

  it('leaves an under-cap constitution byte-identical', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), 'small body');
    const ctx = buildConstitutionContext(loader.resolve(repoDir));
    expect(bodyOf(ctx)).toBe('<standards source="CLAUDE.md">\n\nsmall body\n\n</standards>');
    expect(ctx).not.toContain('[truncated');
  });

  it('standards view keeps the Conventions section and drops Repository layout', async () => {
    await writeFile(
      join(repoDir, 'CLAUDE.md'),
      '# Proj\n\nIntro\n\n## Conventions\n\nUse tabs.\n\n### Naming\n\ncamelCase\n\n## Repository layout\n\nsrc/ holds code\n',
    );
    const c = loader.resolve(repoDir);
    const std = buildConstitutionContext(c, 'standards');
    expect(std).toContain('## Conventions');
    expect(std).toContain('Use tabs.');
    expect(std).toContain('camelCase');
    expect(std).not.toContain('Repository layout');
    expect(std).not.toContain('src/ holds code');
    expect(buildConstitutionContext(c)).toContain('Repository layout');
  });

  it('standards view falls back to the full text when no section matches', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), '# Proj\n\n## Overview\n\nhello\n');
    const c = loader.resolve(repoDir);
    expect(buildConstitutionContext(c, 'standards')).toBe(buildConstitutionContext(c, 'full'));
  });

  it('standards view keeps a heading-less instruction file whole while filtering one with matching sections', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), 'Always run verify before committing.');
    await writeFile(join(repoDir, 'AGENTS.md'), '# Agents\n\n## Rules\n\nNo mocks.\n\n## Skills\n\nSkill list.\n');
    const std = buildConstitutionContext(loader.resolve(repoDir), 'standards');
    expect(std).toContain('Always run verify before committing.');
    expect(std).toContain('No mocks.');
    expect(std).not.toContain('Skill list.');
  });

  it('ignores headings inside fenced code', async () => {
    await writeFile(
      join(repoDir, 'CLAUDE.md'),
      '## Overview\n\n```md\n## Standards\n```\n\nfenced-tail\n\n## Rules\n\nreal rule\n',
    );
    const std = buildConstitutionContext(loader.resolve(repoDir), 'standards');
    expect(std).toContain('real rule');
    expect(std).not.toContain('fenced-tail');
  });

  it('names the bundled file in the truncation marker for an untagged body', async () => {
    await writeFile(join(bundledDir, 'acme-app.md'), `---\nproduct: acme-app\n---\n${'- line\n'.repeat(2000)}`);
    const ctx = buildConstitutionContext(loader.resolve(repoDir, 'acme-app'));
    expect(Buffer.byteLength(ctx, 'utf8')).toBeLessThanOrEqual(CONSTITUTION_MAX_BYTES);
    expect(bodyOf(ctx)).toMatch(/\[truncated — see acme-app\.md\]$/);
  });

  it('never splits a multibyte character', async () => {
    await writeFile(join(repoDir, 'CLAUDE.md'), 'é😀'.repeat(5000));
    const ctx = buildConstitutionContext(loader.resolve(repoDir));
    expect(Buffer.byteLength(ctx, 'utf8')).toBeLessThanOrEqual(CONSTITUTION_MAX_BYTES);
    expect(ctx).not.toContain('�');
    expect(ctx).toContain('[truncated — see CLAUDE.md]');
  });
});
