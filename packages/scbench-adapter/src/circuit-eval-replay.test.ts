// Regression replay for the live circuit_eval checkpoint-3 miss (#1188): Core 18/18
// but Functionality 66/82 produced no rework brief, and the comparator failure carried
// through checkpoints 4-8. The committed fixture reproduces that exact shape; the replay
// proves the rework path (buildRetryContext → retryCheckpoint) turns it into a rework-1/
// brief naming both comparator tests while leaving first-attempt evidence byte-identical.
// The retrySkipReason gate for this shape is #1191's scope; the fixture-shape test below asserts it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEvaluation } from './baseline.js';
import type { ScbenchCheckpoint } from './checkpoint.js';
import { minimalManifest } from './manifest-fixture.js';
import { retryCheckpoint } from './retry-checkpoint.js';
import { buildRetryContext, retrySkipReason } from './retry-context.js';
import { createExecaExec, type ExecFn } from './workspace.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./__fixtures__/retry/evaluation-circuit-eval-checkpoint3.json', import.meta.url),
);

const CHECKPOINT: ScbenchCheckpoint = {
  problemId: 'circuit_eval',
  checkpointId: 'checkpoint_3',
  index: 2,
  task: 'Add check_circuit and a 2-bit comparator builder to circuit_eval.py.',
};

const FIRST_ATTEMPT_FILES = [
  'manifest.json',
  'request.json',
  'events.ndjson',
  'diff.patch',
  'brief.md',
  'evaluation.json',
];

describe('circuit_eval checkpoint-3 fixture replay', () => {
  it('fixture reproduces the live checkpoint-3 shape: Core 18/18, Functionality 66/82 with both comparator tests failed', () => {
    const evaluation = parseEvaluation(readFileSync(FIXTURE_PATH, 'utf-8'), FIXTURE_PATH);

    expect(evaluation.problem_name).toBe('circuit_eval');
    expect(evaluation.checkpoint_name).toBe('checkpoint_3');
    expect(evaluation.pass_counts).toEqual({ Core: 18, Functionality: 66 });
    expect(evaluation.total_counts).toEqual({ Core: 18, Functionality: 82 });

    const core = evaluation.tests!['checkpoint_3-Core'];
    expect(core.passed.length).toBe(18);
    expect(core.failed).toEqual([]);

    const functionality = evaluation.tests!['checkpoint_3-Functionality'];
    expect(functionality.passed.length).toBe(66);
    expect(functionality.failed.length).toBe(16);
    expect(functionality.failed).toContain('test_check_comparator_2bit_circuit');
    expect(functionality.failed).toContain('test_comparator_2bit_exhaustive');

    expect(retrySkipReason(evaluation)).toBeUndefined();
  });

  describe('replaying the fixture through the rework path', () => {
    let workspace: string;
    let artifactsRoot: string;
    let checkpointDir: string;
    const realExec = createExecaExec();

    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), 'scbench-replay-ws-'));
      artifactsRoot = mkdtempSync(join(tmpdir(), 'scbench-replay-artifacts-'));
      checkpointDir = join(artifactsRoot, 'circuit_eval', 'checkpoint_3');
      // Pre-seed the first attempt's evidence — the replay must never touch it.
      mkdirSync(checkpointDir, { recursive: true });
      writeFileSync(join(checkpointDir, 'manifest.json'), JSON.stringify(minimalManifest()));
      writeFileSync(join(checkpointDir, 'request.json'), '{}');
      writeFileSync(join(checkpointDir, 'events.ndjson'), '');
      writeFileSync(join(checkpointDir, 'diff.patch'), '');
      writeFileSync(join(checkpointDir, 'brief.md'), '# first attempt brief\n');
      writeFileSync(join(checkpointDir, 'evaluation.json'), readFileSync(FIXTURE_PATH, 'utf-8'));
    });

    afterEach(() => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(artifactsRoot, { recursive: true, force: true });
    });

    it('writes rework-1/ with a brief naming both comparator tests and preserves first-attempt evidence byte-for-byte', async () => {
      const firstAttemptBytes = new Map(
        FIRST_ATTEMPT_FILES.map((f) => [f, readFileSync(join(checkpointDir, f), 'utf-8')]),
      );

      const evaluation = parseEvaluation(readFileSync(FIXTURE_PATH, 'utf-8'), FIXTURE_PATH);
      const ctx = buildRetryContext(evaluation);
      expect(ctx.failedTests).toContainEqual({
        group: 'checkpoint_3-Functionality',
        name: 'test_check_comparator_2bit_circuit',
      });
      expect(ctx.failedTests).toContainEqual({
        group: 'checkpoint_3-Functionality',
        name: 'test_comparator_2bit_exhaustive',
      });
      expect(ctx.failedTests.length).toBe(16);

      const exec: ExecFn = async (argv, opts) => {
        const [bin, ...rest] = argv;
        if (bin === 'git') return realExec(argv, opts);
        if (bin === 'stub-factory') {
          // rest === ['run-brief', briefPath, '--workspace', ws, '--artifacts', artifactsDir]
          const artifactsDir = rest[5];
          mkdirSync(artifactsDir, { recursive: true });
          writeFileSync(join(artifactsDir, 'manifest.json'), JSON.stringify(minimalManifest()));
          writeFileSync(join(artifactsDir, 'request.json'), '{}');
          writeFileSync(join(artifactsDir, 'events.ndjson'), '');
          writeFileSync(join(artifactsDir, 'diff.patch'), '');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command: ${argv.join(' ')}`);
      };

      const result = await retryCheckpoint(
        CHECKPOINT,
        ctx,
        { workspace, artifactsRoot, factoryBin: 'stub-factory' },
        { exec },
      );

      const reworkDir = join(checkpointDir, 'rework-1');
      expect(result.outcome).toBe('ready');
      expect(result.artifactsDir).toBe(reworkDir);
      expect(existsSync(join(reworkDir, 'manifest.json'))).toBe(true);

      // The rework brief names both comparator tests with their group label.
      const brief = readFileSync(join(reworkDir, 'brief.md'), 'utf-8');
      expect(brief).toContain('test_check_comparator_2bit_circuit');
      expect(brief).toContain('test_comparator_2bit_exhaustive');
      expect(brief).toContain('checkpoint_3-Functionality');

      expect(JSON.parse(readFileSync(result.retryContextPath, 'utf-8'))).toEqual(ctx);

      // Every first-attempt evidence file — including the fixture-derived
      // evaluation.json — is byte-identical after the replay.
      for (const [file, bytes] of firstAttemptBytes) {
        expect(readFileSync(join(checkpointDir, file), 'utf-8')).toBe(bytes);
      }
    });
  });
});
