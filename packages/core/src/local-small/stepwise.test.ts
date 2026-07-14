import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLocalSmallPatchStep, createLocalSmallDryRun } from './stepwise.js';

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

describe('local-small schema-bound patch step', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('validates, applies one constrained patch, and runs verification', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');
    const commands: string[] = [];

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: {
        issue: 167,
        issueTitle: 'Apply one schema-bound local-small patch step',
        stepId: 'schema-bound-change',
        stepTitle: 'Propose one schema-bound patch',
        dryRun: true,
        allowedFiles: ['src/app.ts'],
        limits: { maxFilesPerStep: 4, maxContextTokens: 2000 },
        instructions: [],
        issueBody: '',
        specExcerpt: '',
      },
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Update exported value',
        changes: [{ file: 'src/app.ts', find: 'value = 1', replace: 'value = 2' }],
        verifyCommand: 'npm test -- src/app.test.ts',
      },
      run: async (command) => {
        commands.push(command);
        return { stdout: 'ok\n', stderr: '' };
      },
    });

    expect(result.status).toBe('success');
    expect(readFileSync(join(repoRoot, 'src', 'app.ts'), 'utf-8')).toBe('export const value = 2;\n');
    expect(commands).toEqual(['npm test -- src/app.test.ts']);
    expect(result.reportEvent).toEqual({
      type: 'local-small-step',
      msg: 'schema-bound-change success: Update exported value; verified with npm test -- src/app.test.ts',
    });
  });

  it('rejects invalid proposals before applying files', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(['src/app.ts']),
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Try an outside file',
        changes: [{ file: 'src/other.ts', find: 'x', replace: 'y' }],
        verifyCommand: 'npm test',
      },
      run: async () => {
        throw new Error('verification should not run');
      },
    });

    expect(result.status).toBe('repair-needed');
    expect(result.reason).toContain('not in allowed files');
    expect(readFileSync(join(repoRoot, 'src', 'app.ts'), 'utf-8')).toBe('export const value = 1;\n');
  });

  it('returns repair-needed when the patch cannot be applied', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(['src/app.ts']),
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Replace missing text',
        changes: [{ file: 'src/app.ts', find: 'value = 9', replace: 'value = 2' }],
        verifyCommand: 'npm test',
      },
      run: async () => {
        throw new Error('verification should not run');
      },
    });

    expect(result.status).toBe('repair-needed');
    expect(result.reason).toContain('find text was not present');
    expect(readFileSync(join(repoRoot, 'src', 'app.ts'), 'utf-8')).toBe('export const value = 1;\n');
  });

  it('does not leave a partial patch when a later change cannot be applied', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const app = 1;\n');
    writeFileSync(join(repoRoot, 'src', 'util.ts'), 'export const util = 1;\n');

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(['src/app.ts', 'src/util.ts']),
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Update two files',
        changes: [
          { file: 'src/app.ts', find: 'app = 1', replace: 'app = 2' },
          { file: 'src/util.ts', find: 'util = 9', replace: 'util = 2' },
        ],
        verifyCommand: 'npm test',
      },
      run: async () => {
        throw new Error('verification should not run');
      },
    });

    expect(result.status).toBe('repair-needed');
    expect(readFileSync(join(repoRoot, 'src', 'app.ts'), 'utf-8')).toBe('export const app = 1;\n');
    expect(readFileSync(join(repoRoot, 'src', 'util.ts'), 'utf-8')).toBe('export const util = 1;\n');
  });

  it('rejects unsafe relative paths even if they appear in the context pack', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(repoRoot, { recursive: true });

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(['../outside.ts']),
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Escape repo root',
        changes: [{ file: '../outside.ts', find: 'x', replace: 'y' }],
        verifyCommand: 'npm test',
      },
    });

    expect(result.status).toBe('repair-needed');
    expect(result.reason).toContain('unsafe path');
  });

  it('rejects duplicate file entries to keep patch application deterministic', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(['src/app.ts']),
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Duplicate edits',
        changes: [
          { file: 'src/app.ts', find: 'value = 1', replace: 'value = 2' },
          { file: 'src/app.ts', find: 'const', replace: 'let' },
        ],
        verifyCommand: 'npm test',
      },
    });

    expect(result.status).toBe('repair-needed');
    expect(result.reason).toContain('duplicate file');
    expect(readFileSync(join(repoRoot, 'src', 'app.ts'), 'utf-8')).toBe('export const value = 1;\n');
  });

  it('returns repair-needed when verification fails after applying', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');

    const result = await applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(['src/app.ts']),
      proposal: {
        stepId: 'schema-bound-change',
        summary: 'Update exported value',
        changes: [{ file: 'src/app.ts', find: 'value = 1', replace: 'value = 2' }],
        verifyCommand: 'npm test',
      },
      run: async () => {
        throw new Error('tests failed');
      },
    });

    expect(result.status).toBe('repair-needed');
    expect(result.reason).toContain('verification failed');
    expect(readFileSync(join(repoRoot, 'src', 'app.ts'), 'utf-8')).toBe('export const value = 2;\n');
  });
});

function contextPackFor(allowedFiles: string[]) {
  return {
    issue: 167,
    issueTitle: 'Apply one schema-bound local-small patch step',
    stepId: 'schema-bound-change' as const,
    stepTitle: 'Propose one schema-bound patch',
    dryRun: true as const,
    allowedFiles,
    limits: { maxFilesPerStep: 4, maxContextTokens: 2000 },
    instructions: [],
    issueBody: '',
    specExcerpt: '',
  };
}
