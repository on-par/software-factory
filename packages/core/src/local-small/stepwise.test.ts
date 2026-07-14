import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSmallDryRun } from './stepwise.js';

let tmpDir: string | undefined;

describe('local-small stepwise dry-run harness', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('writes a deterministic bounded step plan and first context pack', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    const outputDir = join(tmpDir, 'artifacts');
    const specPath = join(tmpDir, 'issue-166.md');
    await mkdir(repoRoot);
    writeFileSync(join(repoRoot, 'source.ts'), 'export const value = 1;\n');
    writeFileSync(specPath, [
      '# Spec: Introduce local-small stepwise harness skeleton (#166)',
      'Update `packages/core/src/local-small/stepwise.ts` and `packages/core/src/index.ts`.',
      'Run `npm test -- packages/core/src/local-small/stepwise.test.ts`.',
    ].join('\n'));

    const result = await createLocalSmallDryRun({
      issue: 166,
      issueTitle: 'Introduce local-small stepwise harness skeleton',
      issueBody: 'Create a dry-run skeleton with deterministic output.',
      repoRoot,
      specPath,
      outputDir,
      now: () => new Date('2026-07-14T12:00:00.000Z'),
    });

    expect(result.plan.steps.map(step => step.id)).toEqual([
      'inspect-context',
      'schema-bound-change',
      'verify-and-report',
    ]);
    expect(result.plan.steps.every(step => step.maxFiles <= 4)).toBe(true);
    expect(result.plan.steps.every(step => step.maxTokens <= 2000)).toBe(true);
    expect(result.contextPack.stepId).toBe('inspect-context');
    expect(result.contextPack.allowedFiles).toEqual([
      'packages/core/src/local-small/stepwise.ts',
      'packages/core/src/index.ts',
    ]);
    expect(readFileSync(result.planPath, 'utf-8')).toMatchSnapshot();
    expect(readFileSync(result.contextPath, 'utf-8')).toMatchSnapshot();
  });

  it('does not modify source files in the target repo', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    const outputDir = join(tmpDir, 'repo', '.factory', 'local-small', 'issue-166');
    const specPath = join(tmpDir, 'repo', '.factory', 'plans', 'issue-166.md');
    await mkdir(join(tmpDir, 'repo', 'src'), { recursive: true });
    await mkdir(join(tmpDir, 'repo', '.factory', 'plans'), { recursive: true });
    writeFileSync(join(tmpDir, 'repo', 'src', 'app.ts'), 'export const app = true;\n');
    writeFileSync(specPath, 'Touch `src/app.ts` only in a later patch step.\n');

    await createLocalSmallDryRun({
      issue: 166,
      issueTitle: 'Introduce local-small stepwise harness skeleton',
      issueBody: '',
      repoRoot,
      specPath,
      outputDir,
    });

    expect(readFileSync(join(tmpDir, 'repo', 'src', 'app.ts'), 'utf-8')).toBe('export const app = true;\n');
    expect(await readdir(join(tmpDir, 'repo', 'src'))).toEqual(['app.ts']);
    expect(existsSync(join(outputDir, 'step-plan.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'step-1-context.md'))).toBe(true);
  });
});
