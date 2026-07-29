import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchmarkManifest } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScbenchCheckpoint } from './checkpoint.js';
import { runCheckpoint } from './run-checkpoint.js';
import { createExecaExec, type ExecFn } from './workspace.js';

function minimalManifest(overrides: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    manifestVersion: 1,
    run: {
      issue: 9_000_001,
      profile: 'local-only',
      outcome: 'ready',
      startedAt: '2026-07-28T00:00:00.000Z',
      endedAt: '2026-07-28T00:01:00.000Z',
      elapsedMs: 60_000,
      workspace: '/tmp/ws',
    },
    phases: { plan: 'ok', build: 'ok', check: 'ok', ship: 'skipped' },
    modelAttempts: [],
    cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, entries: [] },
    git: { changedFiles: [], diffStat: '', diffBase: 'HEAD' },
    artifacts: { manifest: 'manifest.json', request: 'request.json', events: 'events.ndjson', diff: 'diff.patch' },
    ...overrides,
  };
}

function writeFactoryArtifacts(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(minimalManifest()));
  writeFileSync(join(dir, 'request.json'), '{}');
  writeFileSync(join(dir, 'events.ndjson'), '');
  writeFileSync(join(dir, 'diff.patch'), '');
}

describe('runCheckpoint (2-checkpoint smoke)', () => {
  let workspace: string;
  let artifactsRoot: string;
  const realExec = createExecaExec();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'scbench-run-ws-'));
    artifactsRoot = mkdtempSync(join(tmpdir(), 'scbench-run-artifacts-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(artifactsRoot, { recursive: true, force: true });
  });

  it('reuses the workspace across checkpoints and writes isolated artifacts', async () => {
    const commandLog: string[][] = [];
    const workspaceCwds: string[] = [];

    const exec: ExecFn = async (argv, opts) => {
      commandLog.push([...argv]);
      const [bin, ...rest] = argv;

      if (bin === 'git') return realExec(argv, opts);

      if (bin === 'stub-factory') {
        workspaceCwds.push(opts.cwd);
        // rest === ['run-brief', briefPath, '--workspace', ws, '--artifacts', artifactsDir]
        const artifactsDir = rest[5];
        if (artifactsDir.endsWith(join('calculator', '1'))) {
          expect(existsSync(join(workspace, 'calc.py'))).toBe(false);
          writeFileSync(join(workspace, 'calc.py'), 'def add(a, b):\n    return a + b\n');
        } else {
          expect(existsSync(join(workspace, 'calc.py'))).toBe(true);
          const existing = readFileSync(join(workspace, 'calc.py'), 'utf-8');
          writeFileSync(join(workspace, 'calc.py'), `${existing}\n\ndef subtract(a, b):\n    return a - b\n`);
        }
        writeFactoryArtifacts(artifactsDir);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      throw new Error(`unexpected command: ${argv.join(' ')}`);
    };

    const checkpoints: ScbenchCheckpoint[] = [
      { problemId: 'calculator', checkpointId: '1', index: 0, task: 'Add calc.py with an `add` function.' },
      { problemId: 'calculator', checkpointId: '2', index: 1, task: 'Add a `subtract` function to calc.py.' },
    ];

    const results = [];
    for (const checkpoint of checkpoints) {
      results.push(await runCheckpoint(checkpoint, { workspace, artifactsRoot, factoryBin: 'stub-factory' }, { exec }));
    }

    expect(results.map((r) => r.outcome)).toEqual(['ready', 'ready']);

    // Both checkpoints ran factory in the same persistent workspace.
    expect(new Set(workspaceCwds)).toEqual(new Set([workspace]));

    // Per-checkpoint artifact dirs each hold the four fixed files.
    for (const checkpointId of ['1', '2']) {
      const dir = join(artifactsRoot, 'calculator', checkpointId);
      for (const file of ['manifest.json', 'request.json', 'events.ndjson', 'diff.patch']) {
        expect(existsSync(join(dir, file))).toBe(true);
      }
    }

    // Briefs live under the artifacts root, never inside the workspace.
    expect(existsSync(join(artifactsRoot, 'calculator', '1', 'brief.md'))).toBe(true);
    expect(existsSync(join(artifactsRoot, 'calculator', '2', 'brief.md'))).toBe(true);
    expect(existsSync(join(workspace, 'brief.md'))).toBe(false);

    // Workspace reuse: checkpoint 2 saw checkpoint 1's edits.
    const finalCalc = readFileSync(join(workspace, 'calc.py'), 'utf-8');
    expect(finalCalc).toContain('def add');
    expect(finalCalc).toContain('def subtract');

    // One commit per checkpoint, in order.
    const log = await realExec(['git', 'log', '--format=%s'], { cwd: workspace });
    const messages = log.stdout.trim().split('\n');
    expect(messages).toContain('scbench: checkpoint 1');
    expect(messages).toContain('scbench: checkpoint 2');

    // No command besides git/stub-factory ever ran — no GitHub, queue, or PR side effects possible.
    expect(commandLog.every((argv) => argv[0] === 'git' || argv[0] === 'stub-factory')).toBe(true);
  });

  it('returns outcome "error" (not a throw) when Factory crashes before writing a manifest', async () => {
    const exec: ExecFn = async (argv, opts) => {
      const [bin] = argv;
      if (bin === 'git') return realExec(argv, opts);
      if (bin === 'stub-factory') {
        // Simulate a crash that still left a partial edit behind, so the
        // post-failure commitCheckpoint call has something to commit.
        writeFileSync(join(workspace, 'partial.py'), '# crashed mid-write\n');
        return { exitCode: 1, stdout: '', stderr: 'crashed before manifest' };
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    };

    const checkpoint: ScbenchCheckpoint = { problemId: 'calculator', checkpointId: '1', index: 0, task: 'Do it.' };

    const result = await runCheckpoint(checkpoint, { workspace, artifactsRoot, factoryBin: 'stub-factory' }, { exec });

    expect(result.outcome).toBe('error');
    expect(result.detail).toMatch(/no manifest\.json found/);

    // The workspace still gets committed even on an adapter-level failure.
    const log = await realExec(['git', 'log', '--format=%s'], { cwd: workspace });
    expect(log.stdout).toContain('scbench: checkpoint 1');
  });
});
