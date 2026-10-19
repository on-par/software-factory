import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConstitutionLoader,
  DEFAULT_REPO_CONSTITUTION_PATH,
  DEFAULT_REVIEW_CONSTITUTION,
  describeReviewConstitutionSource,
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

describe('ConstitutionLoader.resolveForReview (#1673)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'review-repo-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('prefers .factory/constitution.md and does not merge instruction files', async () => {
    await mkdir(join(repoDir, '.factory'), { recursive: true });
    await writeFile(join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH), BUNDLED);
    await writeFile(join(repoDir, 'AGENTS.md'), 'agents rules');

    const r = new ConstitutionLoader().resolveForReview(repoDir);
    expect(r.source).toEqual({ kind: 'repo-constitution', path: DEFAULT_REPO_CONSTITUTION_PATH });
    expect(r.constitution.product).toBe('acme-app');
    expect(r.constitution.body).not.toContain('agents rules');
  });

  it('uses instruction files when there is no repo constitution', async () => {
    await writeFile(join(repoDir, 'AGENTS.md'), 'agents rules');

    const r = new ConstitutionLoader().resolveForReview(repoDir);
    expect(r.source).toEqual({ kind: 'instruction-files', files: ['AGENTS.md'] });
    expect(r.constitution.source).toBe('repo');
    expect(r.constitution.body).toContain('agents rules');
  });

  it('lists instruction files in priority order', async () => {
    await writeFile(join(repoDir, 'AGENTS.md'), 'a');
    await writeFile(join(repoDir, 'CLAUDE.md'), 'c');

    const r = new ConstitutionLoader().resolveForReview(repoDir);
    expect(r.source).toEqual({ kind: 'instruction-files', files: ['CLAUDE.md', 'AGENTS.md'] });
  });

  it('falls through an empty repo constitution to the instruction files', async () => {
    await mkdir(join(repoDir, '.factory'), { recursive: true });
    await writeFile(join(repoDir, DEFAULT_REPO_CONSTITUTION_PATH), '  \n');
    await writeFile(join(repoDir, 'CLAUDE.md'), 'c');

    expect(new ConstitutionLoader().resolveForReview(repoDir).source.kind).toBe('instruction-files');
  });

  it('honors a custom constitution path', async () => {
    await writeFile(join(repoDir, 'standards.md'), BUNDLED);

    const r = new ConstitutionLoader().resolveForReview(repoDir, 'standards.md');
    expect(r.source).toEqual({ kind: 'repo-constitution', path: 'standards.md' });
  });

  it('falls back to the bundled default review constitution', () => {
    const r = new ConstitutionLoader().resolveForReview(repoDir);
    expect(r.source).toEqual({ kind: 'default', product: DEFAULT_REVIEW_CONSTITUTION });
    expect(r.constitution.product).toBe('default-review');
    expect(r.constitution.checkers).toEqual(['compile', 'tests', 'lint']);
    expect(r.constitution.checkers.some((c) => c.startsWith('custom_'))).toBe(false);
    expect(r.constitution.body.trim()).not.toBe('');
  });

  it('describes each source', () => {
    expect(describeReviewConstitutionSource({ kind: 'repo-constitution', path: '.factory/constitution.md' })).toContain(
      '.factory/constitution.md',
    );
    expect(
      describeReviewConstitutionSource({ kind: 'instruction-files', files: ['CLAUDE.md', 'AGENTS.md'] }),
    ).toContain('CLAUDE.md, AGENTS.md');
    expect(describeReviewConstitutionSource({ kind: 'default', product: DEFAULT_REVIEW_CONSTITUTION })).toContain(
      'built-in default review constitution',
    );
  });
});
