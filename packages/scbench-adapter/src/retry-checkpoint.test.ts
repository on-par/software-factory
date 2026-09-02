import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterError, type ScbenchCheckpoint } from './checkpoint.js';
import { minimalManifest } from './manifest-fixture.js';
import { retryCheckpoint } from './retry-checkpoint.js';
import type { ScbenchRetryContext } from './retry-context.js';
import { createExecaExec, type ExecFn } from './workspace.js';

const CHECKPOINT: ScbenchCheckpoint = {
  problemId: 'calculator',
  checkpointId: '1',
  index: 0,
  task: 'Add calc.py with an `add` function.',
};

const CONTEXT: ScbenchRetryContext = {
  problemId: 'calculator',
  checkpointId: '1',
  passPolicy: 'core-cases',
  pytestExitCode: 1,
  failedTests: [{ group: 'checkpoint_1-Core', name: 'test_add_negative' }],
  stderrExcerpt: 'AssertionError: add(-1, -1) should be -2',
};

function writeFactoryArtifacts(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(minimalManifest()));
  writeFileSync(join(dir, 'request.json'), '{}');
  writeFileSync(join(dir, 'events.ndjson'), '');
  writeFileSync(join(dir, 'diff.patch'), '');
}

describe('retryCheckpoint', () => {
  let workspace: string;
  let artifactsRoot: string;
  let checkpointDir: string;
  const realExec = createExecaExec();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'scbench-retry-ws-'));
    artifactsRoot = mkdtempSync(join(tmpdir(), 'scbench-retry-artifacts-'));
    checkpointDir = join(artifactsRoot, 'calculator', '1');
    // Pre-seed the first attempt's artifacts — a retry must never touch them.
    writeFactoryArtifacts(checkpointDir);
    writeFileSync(join(checkpointDir, 'brief.md'), '# first attempt brief\n');
    writeFileSync(join(checkpointDir, 'evaluation.json'), '{"native": "evidence"}');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(artifactsRoot, { recursive: true, force: true });
  });

  function stubFactoryExec(onFactory: (artifactsDir: string) => { exitCode: number; stdout: string; stderr: string }) {
    const commandLog: string[][] = [];
    const exec: ExecFn = async (argv, opts) => {
      commandLog.push([...argv]);
      const [bin, ...rest] = argv;
      if (bin === 'git') return realExec(argv, opts);
      if (bin === 'stub-factory') {
        // rest === ['run-brief', briefPath, '--workspace', ws, '--artifacts', artifactsDir]
        return onFactory(rest[5]);
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    };
    return { exec, commandLog };
  }

  it('runs factory against rework-1/, persists brief + retry context, and leaves the first attempt byte-identical', async () => {
    const firstAttemptBytes = new Map(
      ['manifest.json', 'request.json', 'events.ndjson', 'diff.patch', 'brief.md', 'evaluation.json'].map((f) => [
        f,
        readFileSync(join(checkpointDir, f), 'utf-8'),
      ]),
    );
    const { exec, commandLog } = stubFactoryExec((artifactsDir) => {
      writeFileSync(join(workspace, 'calc.py'), 'def add(a, b):\n    return a + b\n');
      writeFactoryArtifacts(artifactsDir);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await retryCheckpoint(
      CHECKPOINT,
      CONTEXT,
      { workspace, artifactsRoot, factoryBin: 'stub-factory' },
      { exec },
    );

    const reworkDir = join(checkpointDir, 'rework-1');
    expect(result.outcome).toBe('ready');
    expect(result.artifactsDir).toBe(reworkDir);
    expect(result.retryContextPath).toBe(join(reworkDir, 'retry-context.json'));

    // The run-brief argv pointed factory at the rework directory.
    const factoryArgv = commandLog.find((argv) => argv[0] === 'stub-factory')!;
    expect(factoryArgv[6]).toBe(reworkDir);
    expect(factoryArgv[2]).toBe(join(reworkDir, 'brief.md'));

    // Brief + retry context landed in rework-1/.
    expect(readFileSync(join(reworkDir, 'brief.md'), 'utf-8')).toContain('checkpoint_1-Core: test_add_negative');
    expect(JSON.parse(readFileSync(result.retryContextPath, 'utf-8'))).toEqual(CONTEXT);

    // First-attempt artifacts and native evidence are byte-identical.
    for (const [file, bytes] of firstAttemptBytes) {
      expect(readFileSync(join(checkpointDir, file), 'utf-8')).toBe(bytes);
    }

    // The workspace commit message carries the -rework-1 suffix.
    const log = await realExec(['git', 'log', '--format=%s'], { cwd: workspace });
    expect(log.stdout.trim().split('\n')).toContain('scbench: checkpoint 1-rework-1');
  });

  it('returns outcome "error" (not a throw) when factory exits non-zero without a manifest', async () => {
    const { exec } = stubFactoryExec(() => ({ exitCode: 1, stdout: '', stderr: 'crashed before manifest' }));

    const result = await retryCheckpoint(
      CHECKPOINT,
      CONTEXT,
      { workspace, artifactsRoot, factoryBin: 'stub-factory' },
      { exec },
    );

    expect(result.outcome).toBe('error');
    expect(result.detail).toMatch(/no manifest\.json found/);
    expect(result.detail).toMatch(/factory exited 1: crashed before manifest/);
    expect(result.retryContextPath).toBe(join(checkpointDir, 'rework-1', 'retry-context.json'));
  });

  it('keeps an already-successful result when the post-run commit fails', async () => {
    const exec: ExecFn = async (argv, opts) => {
      const [bin, ...rest] = argv;
      if (bin === 'git') {
        const isCheckpointCommit = rest.includes('commit') && rest.some((a) => a.includes('scbench: checkpoint'));
        if (isCheckpointCommit) return { exitCode: 1, stdout: '', stderr: 'fatal: unable to write new_index file' };
        return realExec(argv, opts);
      }
      if (bin === 'stub-factory') {
        writeFactoryArtifacts(rest[5]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    };

    const result = await retryCheckpoint(
      CHECKPOINT,
      CONTEXT,
      { workspace, artifactsRoot, factoryBin: 'stub-factory' },
      { exec },
    );

    expect(result.outcome).toBe('ready');
    expect(result.detail).toMatch(/workspace commit failed/);
  });

  it('fails closed on a second invocation once rework-1/manifest.json exists, with zero side effects', async () => {
    const { exec, commandLog } = stubFactoryExec((artifactsDir) => {
      writeFactoryArtifacts(artifactsDir);
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await retryCheckpoint(CHECKPOINT, CONTEXT, { workspace, artifactsRoot, factoryBin: 'stub-factory' }, { exec });
    const commandCountAfterFirst = commandLog.length;

    await expect(
      retryCheckpoint(CHECKPOINT, CONTEXT, { workspace, artifactsRoot, factoryBin: 'stub-factory' }, { exec }),
    ).rejects.toThrow(AdapterError);
    await expect(
      retryCheckpoint(CHECKPOINT, CONTEXT, { workspace, artifactsRoot, factoryBin: 'stub-factory' }, { exec }),
    ).rejects.toThrow(/rework-1.*one rework attempt per checkpoint/);

    // The duplicate invocations ran nothing — the check fires before prepareWorkspace.
    expect(commandLog.length).toBe(commandCountAfterFirst);
    expect(existsSync(join(checkpointDir, 'rework-2'))).toBe(false);
  });
});
