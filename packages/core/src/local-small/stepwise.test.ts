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
    writeFileSync(
      specPath,
      [
        '# Spec: Introduce local-small stepwise harness skeleton (#166)',
        'Update `packages/core/src/local-small/stepwise.ts` and `packages/core/src/index.ts`.',
        'Run `npm test -- packages/core/src/local-small/stepwise.test.ts`.',
      ].join('\n'),
    );

    const result = await createLocalSmallDryRun({
      issue: 166,
      issueTitle: 'Introduce local-small stepwise harness skeleton',
      issueBody: 'Create a dry-run skeleton with deterministic output.',
      repoRoot,
      specPath,
      outputDir,
      now: () => new Date('2026-07-14T12:00:00.000Z'),
    });

    expect(result.plan.steps.map((step) => step.id)).toEqual([
      'inspect-context',
      'schema-bound-change',
      'verify-and-report',
    ]);
    expect(result.plan.steps.every((step) => step.maxFiles <= 4)).toBe(true);
    expect(result.plan.steps.every((step) => step.maxTokens <= 2000)).toBe(true);
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

describe('local-small proposal validation branches', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function runProposal(proposal: unknown, allowedFiles = ['src/app.ts']) {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');
    return applyLocalSmallPatchStep({
      repoRoot,
      contextPack: contextPackFor(allowedFiles),
      proposal,
      run: async () => {
        throw new Error('verification should not run for invalid proposals');
      },
    });
  }

  const base = {
    stepId: 'schema-bound-change' as const,
    summary: 'Valid summary',
    verifyCommand: 'npm test',
    changes: [{ file: 'src/app.ts', find: 'value = 1', replace: 'value = 2' }],
  };

  it('rejects a non-object proposal', async () => {
    expect((await runProposal('not an object')).reason).toContain('must be an object');
  });

  it('rejects a stepId that does not match the context pack', async () => {
    expect((await runProposal({ ...base, stepId: 'inspect-context' })).reason).toContain('stepId must match');
  });

  it('rejects a blank summary', async () => {
    expect((await runProposal({ ...base, summary: '   ' })).reason).toContain('summary is required');
  });

  it('rejects a blank verifyCommand', async () => {
    expect((await runProposal({ ...base, verifyCommand: '' })).reason).toContain('verifyCommand is required');
  });

  it('rejects a non-array changes field', async () => {
    expect((await runProposal({ ...base, changes: 'nope' })).reason).toContain('non-empty array');
  });

  it('rejects an empty changes array', async () => {
    expect((await runProposal({ ...base, changes: [] })).reason).toContain('non-empty array');
  });

  it('rejects more changes than maxFilesPerStep', async () => {
    const changes = Array.from({ length: 5 }, (_v, i) => ({ file: `src/f${i}.ts`, find: 'a', replace: 'b' }));
    expect((await runProposal({ ...base, changes })).reason).toContain('exceed maxFilesPerStep');
  });

  it('rejects a change that is not an object', async () => {
    expect((await runProposal({ ...base, changes: [42] })).reason).toContain('each change must be an object');
  });

  it('rejects a change with no file', async () => {
    expect((await runProposal({ ...base, changes: [{ find: 'a', replace: 'b' }] })).reason).toContain(
      'requires a file',
    );
  });

  it('rejects a change with an empty find', async () => {
    const result = await runProposal({ ...base, changes: [{ file: 'src/app.ts', find: '', replace: 'b' }] });
    expect(result.reason).toContain('find text is required');
  });

  it('rejects a change with a non-string replace', async () => {
    const result = await runProposal({ ...base, changes: [{ file: 'src/app.ts', find: 'value = 1', replace: 42 }] });
    expect(result.reason).toContain('replace text is required');
  });

  it('reports repair-needed when an allowed file is missing on disk', async () => {
    const result = await runProposal({ ...base, changes: [{ file: 'src/missing.ts', find: 'x', replace: 'y' }] }, [
      'src/missing.ts',
    ]);
    expect(result.status).toBe('repair-needed');
    expect(result.reason).toContain('file could not be read');
  });
});

describe('local-small dry-run inference branches', () => {
  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('falls back to the repo root when the spec names no file paths', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    const outputDir = join(tmpDir, 'artifacts');
    const specPath = join(tmpDir, 'issue-200.md');
    await mkdir(repoRoot);
    writeFileSync(specPath, 'A prose-only spec with no concrete file references at all.\n');

    const result = await createLocalSmallDryRun({
      issue: 200,
      issueTitle: 'Prose only',
      issueBody: 'body',
      repoRoot,
      specPath,
      outputDir,
    });

    expect(result.plan.steps[0].allowedFiles).toEqual(['.']);
  });

  it('ignores urls and parent-traversal paths when inferring allowed files', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    const outputDir = join(tmpDir, 'artifacts');
    const specPath = join(tmpDir, 'issue-201.md');
    await mkdir(repoRoot);
    writeFileSync(
      specPath,
      [
        'Edit `src/keep.ts` for the change.',
        'See `http://example.com/skip.js` for context.',
        'Do not touch `../outside/escape.ts`.',
      ].join('\n'),
    );

    const result = await createLocalSmallDryRun({
      issue: 201,
      issueTitle: 'Filtering',
      issueBody: 'body',
      repoRoot,
      specPath,
      outputDir,
    });

    expect(result.plan.steps[0].allowedFiles).toEqual(['src/keep.ts']);
  });

  it('truncates an oversized spec excerpt and honors a reduced maxSteps', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-stepwise-'));
    const repoRoot = join(tmpDir, 'repo');
    const outputDir = join(tmpDir, 'artifacts');
    const specPath = join(tmpDir, 'issue-202.md');
    await mkdir(repoRoot);
    writeFileSync(specPath, `Edit \`src/big.ts\`.\n${'y'.repeat(200)}`);

    const result = await createLocalSmallDryRun({
      issue: 202,
      issueTitle: 'Truncation',
      issueBody: 'body',
      repoRoot,
      specPath,
      outputDir,
      limits: { maxSpecChars: 80, maxSteps: 2 },
    });

    expect(result.plan.steps).toHaveLength(2);
    expect(result.contextPack.specExcerpt).toContain('[truncated for local-small context pack]');
    expect(result.contextPack.specExcerpt.length).toBeLessThanOrEqual(80);
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
