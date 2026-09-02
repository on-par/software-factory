// packages/scbench-adapter/src/run-suite-rework.test.ts — pins the exact
// retry-checkpoint contract the Python shim auto-invokes after each checkpoint
// eval in a live run-suite run (#1192): red reworks exactly once, green and
// infrastructure_failure skip with the reason logged, first-attempt evidence
// stays byte-identical, and no non-native evaluation format is ever emitted.
// Exercised end-to-end through main(['retry-checkpoint', ...]) with the REAL
// retryCheckpoint (fake factory exec, real git) — the same subcommand
// software_factory.py shells out to.
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main, type CliDeps } from './cli-run.js';
import { minimalManifest } from './manifest-fixture.js';
import { retryCheckpoint } from './retry-checkpoint.js';
import { createExecaExec, type ExecFn } from './workspace.js';

const RED_EVALUATION_PATH = fileURLToPath(
  new URL('./__fixtures__/retry/evaluation-circuit-eval-checkpoint3.json', import.meta.url),
);

const GREEN_EVALUATION = {
  problem_name: 'circuit_eval',
  checkpoint_name: 'checkpoint_3',
  tests: { 'checkpoint_3-Core': { passed: ['test_a', 'test_b'], failed: [], skipped: [] } },
  pass_counts: { Core: 2 },
  total_counts: { Core: 2 },
  pytest_exit_code: 0,
  infrastructure_failure: false,
};

const INFRA_EVALUATION = {
  problem_name: 'circuit_eval',
  checkpoint_name: 'checkpoint_3',
  pass_counts: {},
  total_counts: { Core: 2 },
  pytest_exit_code: 3,
  infrastructure_failure: true,
};

const FIRST_ATTEMPT_FILES = [
  'manifest.json',
  'request.json',
  'events.ndjson',
  'diff.patch',
  'brief.md',
  'evaluation.json',
];

describe('run-suite auto-invoked retry-checkpoint contract', () => {
  let workspace: string;
  let artifactsRoot: string;
  let checkpointDir: string;
  let taskPath: string;
  let evaluationPath: string;
  let factoryInvocations: number;
  let deps: CliDeps;
  const realExec = createExecaExec();

  const argvFor = (evaluation: string): string[] => [
    'retry-checkpoint',
    '--workspace',
    workspace,
    '--artifacts',
    artifactsRoot,
    '--task-file',
    taskPath,
    '--problem',
    'circuit_eval',
    '--checkpoint',
    'checkpoint_3',
    '--index',
    '2',
    '--evaluation',
    evaluation,
    '--factory-bin',
    'stub-factory',
  ];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'scbench-rework-ws-'));
    artifactsRoot = mkdtempSync(join(tmpdir(), 'scbench-rework-artifacts-'));
    checkpointDir = join(artifactsRoot, 'circuit_eval', 'checkpoint_3');
    taskPath = join(artifactsRoot, 'task.md');
    evaluationPath = join(artifactsRoot, 'evaluation.json');
    writeFileSync(taskPath, 'Add check_circuit and a 2-bit comparator builder to circuit_eval.py.\n');
    // Pre-seed the first attempt's evidence — the rework must never touch it.
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(join(checkpointDir, 'manifest.json'), JSON.stringify(minimalManifest()));
    writeFileSync(join(checkpointDir, 'request.json'), '{}');
    writeFileSync(join(checkpointDir, 'events.ndjson'), '');
    writeFileSync(join(checkpointDir, 'diff.patch'), '');
    writeFileSync(join(checkpointDir, 'brief.md'), '# first attempt brief\n');
    writeFileSync(join(checkpointDir, 'evaluation.json'), readFileSync(RED_EVALUATION_PATH, 'utf-8'));

    factoryInvocations = 0;
    const exec: ExecFn = async (argv, opts) => {
      const [bin, ...rest] = argv;
      if (bin === 'git') return realExec(argv, opts);
      if (bin === 'stub-factory') {
        factoryInvocations += 1;
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

    // Only the deps the retry-checkpoint subcommand touches are real; the
    // rest exist to satisfy CliDeps and must stay uncalled.
    const unused = (name: string) =>
      vi.fn(() => {
        throw new Error(`unexpected call to deps.${name}`);
      });
    deps = {
      readTaskFile: (path) => readFile(path, 'utf-8'),
      readEvaluationFile: (path) => readFile(path, 'utf-8'),
      retryCheckpoint: (cp, ctx, opts) => retryCheckpoint(cp, ctx, opts, { exec }),
      log: vi.fn(),
      logError: vi.fn(),
      env: {},
      runCheckpoint: unused('runCheckpoint'),
      readBaselineConfig: unused('readBaselineConfig'),
      collectBaselineTrials: unused('collectBaselineTrials'),
      writeReport: unused('writeReport'),
      readPinFile: unused('readPinFile'),
      runPinPreflight: unused('runPinPreflight'),
      runCatalogPreflight: unused('runCatalogPreflight'),
      collectTrial: unused('collectTrial'),
      runSuite: unused('runSuite'),
    };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(artifactsRoot, { recursive: true, force: true });
  });

  it('reworks a red checkpoint exactly once and fails a duplicate invocation closed', async () => {
    const firstAttemptBytes = new Map(
      FIRST_ATTEMPT_FILES.map((f) => [f, readFileSync(join(checkpointDir, f), 'utf-8')]),
    );

    const code = await main(argvFor(RED_EVALUATION_PATH), deps);

    expect(code).toBe(0);
    expect(factoryInvocations).toBe(1);
    const reworkDir = join(checkpointDir, 'rework-1');
    expect(existsSync(join(reworkDir, 'retry-context.json'))).toBe(true);
    expect(existsSync(join(reworkDir, 'brief.md'))).toBe(true);
    expect(existsSync(join(reworkDir, 'manifest.json'))).toBe(true);
    for (const [file, bytes] of firstAttemptBytes) {
      expect(readFileSync(join(checkpointDir, file), 'utf-8')).toBe(bytes);
    }

    // The shim re-invoking the same checkpoint must fail closed — the
    // "exactly once" bound lives in the TS subcommand, not the shim.
    const duplicate = await main(argvFor(RED_EVALUATION_PATH), deps);

    expect(duplicate).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining(`retry already recorded at ${reworkDir}`));
    expect(factoryInvocations).toBe(1);
  });

  it('exits 1 on a fully green evaluation with no rework-1/ and no factory invocation', async () => {
    writeFileSync(evaluationPath, JSON.stringify(GREEN_EVALUATION));

    const code = await main(argvFor(evaluationPath), deps);

    expect(code).toBe(1);
    expect(deps.log).toHaveBeenCalledWith(
      'retry-checkpoint: not retryable — checkpoint fully green — every test group passed, nothing to rework',
    );
    expect(existsSync(join(checkpointDir, 'rework-1'))).toBe(false);
    expect(factoryInvocations).toBe(0);
  });

  it('exits 1 on an infrastructure failure, recording the infra reason and skipping rework', async () => {
    writeFileSync(evaluationPath, JSON.stringify(INFRA_EVALUATION));

    const code = await main(argvFor(evaluationPath), deps);

    expect(code).toBe(1);
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('infrastructure failure — provider fault, not a code fault'),
    );
    expect(existsSync(join(checkpointDir, 'rework-1'))).toBe(false);
    expect(factoryInvocations).toBe(0);
  });

  it('emits no evaluation file for rework output — the native evaluation.json stays the only evidence', async () => {
    const sourceBytes = readFileSync(RED_EVALUATION_PATH, 'utf-8');

    const code = await main(argvFor(RED_EVALUATION_PATH), deps);

    expect(code).toBe(0);
    expect(existsSync(join(checkpointDir, 'rework-1', 'evaluation.json'))).toBe(false);
    expect(readFileSync(RED_EVALUATION_PATH, 'utf-8')).toBe(sourceBytes);
    expect(readFileSync(join(checkpointDir, 'evaluation.json'), 'utf-8')).toBe(sourceBytes);
  });
});
