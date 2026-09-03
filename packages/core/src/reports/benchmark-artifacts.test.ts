import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CheckSummary, CostEntry, FactoryEvent } from '../types/index.js';
import type { WorkRequest } from '../work/index.js';
import {
  BENCHMARK_MANIFEST_VERSION,
  buildBenchmarkManifest,
  InvalidArtifactsDirError,
  resolveArtifactsDir,
  writeBenchmarkArtifacts,
} from './benchmark-artifacts.js';

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

const checkSummary: CheckSummary = {
  failures: 0,
  passes: 3,
  skips: 0,
  total: 3,
  results: [
    { checker: 'compile', result: 'PASS', details: 'build succeeded' },
    { checker: 'tests', result: 'PASS', details: 'all tests passed' },
    { checker: 'lint', result: 'PASS', details: 'no lint errors' },
  ],
};

const workRequest: WorkRequest = {
  id: 'local-brief:abc123',
  kind: 'local-brief',
  title: 'Add a widget',
  brief: 'Please add a widget that does the thing.',
  acceptanceCriteria: ['the widget exists'],
};

const events: FactoryEvent[] = [
  {
    ts: '2026-07-28T02:27:23.000Z',
    issue: '137',
    type: 'router',
    msg: 'Trying qwen2.5-coder:14b for plan (attempt 1)',
  },
  {
    ts: '2026-07-28T02:28:11.000Z',
    issue: '137',
    type: 'plan',
    msg: 'Plan complete with model qwen2.5-coder:14b, route: codex',
  },
  {
    ts: '2026-07-28T02:28:12.000Z',
    issue: '137',
    type: 'router',
    msg: 'Trying codex-ollama-qwen3.5:9b for build_codex (attempt 1)',
  },
  {
    ts: '2026-07-28T02:29:20.000Z',
    issue: '137',
    type: 'router',
    msg: 'codex-ollama-qwen3.5:9b failed (empty_response) on build_codex',
  },
];

const costs: CostEntry[] = [
  {
    ts: '2026-07-28T02:28:00.000Z',
    issue: '137',
    task: 'plan',
    model: 'qwen2.5-coder:14b',
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.01,
  },
  {
    ts: '2026-07-28T02:29:00.000Z',
    issue: '137',
    task: 'build_codex',
    model: 'codex-ollama-qwen3.5:9b',
    inputTokens: 200,
    outputTokens: 80,
    cost: 0.02,
  },
];

describe('resolveArtifactsDir', () => {
  it('creates a missing nested directory and returns the absolute path', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-artifacts-'));
    const nested = join(tmpDir, 'nested', 'dir');

    const resolved = resolveArtifactsDir(nested);

    expect(resolved).toBe(nested);
    expect(statSync(nested).isDirectory()).toBe(true);
  });

  it('throws InvalidArtifactsDirError on an empty string', () => {
    expect(() => resolveArtifactsDir('')).toThrow(InvalidArtifactsDirError);
    expect(() => resolveArtifactsDir('   ')).toThrow(InvalidArtifactsDirError);
  });

  it('throws InvalidArtifactsDirError when the path exists as a regular file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-artifacts-'));
    const filePath = join(tmpDir, 'not-a-dir');
    writeFileSync(filePath, 'hello');

    expect(() => resolveArtifactsDir(filePath)).toThrow(InvalidArtifactsDirError);
    expect(() => resolveArtifactsDir(filePath)).toThrow(/is not a directory/);
  });
});

describe('buildBenchmarkManifest', () => {
  it('assembles a success manifest with phases, model attempts, cost totals, and checker', () => {
    const manifest = buildBenchmarkManifest(
      {
        issue: 137,
        artifactsDir: '/tmp/artifacts',
        eventsFile: '/tmp/events.ndjson',
        costsFile: '/tmp/costs.jsonl',
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace: '/workspace',
        branch: 'local-test/137-widget',
        specPath: '/workspace/.factory/plans/issue-137.md',
        route: 'codex',
        request: workRequest,
        checkSummary,
        reworkRounds: 0,
      },
      {
        endedAt: '2026-07-28T02:30:00.000Z',
        events,
        costs,
        changedFiles: ['M src/widget.ts'],
        diffStat: 'src/widget.ts | 4 ++++',
        diffBase: 'origin/main...HEAD',
      },
    );

    expect(manifest.manifestVersion).toBe(BENCHMARK_MANIFEST_VERSION);
    expect(manifest.run).toMatchObject({
      issue: 137,
      profile: 'local-only',
      outcome: 'ready',
      workspace: '/workspace',
      branch: 'local-test/137-widget',
      route: 'codex',
      elapsedMs: 180_000,
    });
    expect(manifest.phases).toEqual({ plan: 'ok', build: 'ok', check: 'ok', ship: 'skipped' });
    expect(manifest.modelAttempts).toEqual([
      { model: 'qwen2.5-coder:14b', task: 'plan', attempt: '1' },
      { model: 'codex-ollama-qwen3.5:9b', task: 'build_codex', attempt: '1' },
      { model: 'codex-ollama-qwen3.5:9b', task: 'build_codex', attempt: '?', reason: 'empty_response' },
    ]);
    expect(manifest.cost).toEqual({
      totalUsd: 0.03,
      inputTokens: 300,
      outputTokens: 130,
      entries: costs,
    });
    expect(manifest.git).toEqual({
      changedFiles: ['M src/widget.ts'],
      diffStat: 'src/widget.ts | 4 ++++',
      diffBase: 'origin/main...HEAD',
    });
    expect(manifest.checker).toEqual(checkSummary);
    expect(manifest.failure).toBeUndefined();
    expect(manifest.request).toEqual(workRequest);
    expect(manifest.artifacts).toMatchObject({
      manifest: 'manifest.json',
      request: 'request.json',
      events: 'events.ndjson',
      diff: 'diff.patch',
    });
  });

  it('marks the failed phase and later worker phases as skipped, and records the typed failure', () => {
    const manifest = buildBenchmarkManifest(
      {
        issue: 138,
        artifactsDir: '/tmp/artifacts',
        eventsFile: '/tmp/events.ndjson',
        costsFile: '/tmp/costs.jsonl',
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'failed',
        workspace: '/workspace',
        failure: { phase: 'build', reason: 'fail', message: 'build escalated: unknown' },
      },
      {
        endedAt: '2026-07-28T02:29:00.000Z',
        events: [],
        costs: [],
        changedFiles: [],
        diffStat: '',
        diffBase: 'none',
      },
    );

    expect(manifest.phases).toEqual({ plan: 'ok', build: 'failed', check: 'skipped', ship: 'skipped' });
    expect(manifest.failure).toEqual({ phase: 'build', reason: 'fail', message: 'build escalated: unknown' });
    expect(manifest.artifacts.events).toBe('events.ndjson');
    expect(manifest.checker).toBeUndefined();
  });
});

describe('writeBenchmarkArtifacts', () => {
  async function setup() {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-artifacts-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const costsFile = join(tmpDir, 'costs.jsonl');
    const artifactsDir = join(tmpDir, 'artifacts');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace);
    mkdirSync(artifactsDir);
    writeFileSync(
      eventsFile,
      [
        JSON.stringify({
          ts: '2026-07-28T02:27:23.000Z',
          issue: '137',
          type: 'router',
          msg: 'Trying model for plan (attempt 1)',
        }),
        JSON.stringify({
          ts: '2026-07-28T02:28:11.000Z',
          issue: '137',
          type: 'ready',
          msg: 'PR #200 ready for review',
        }),
        JSON.stringify({ ts: '2026-07-28T02:28:11.000Z', issue: '999', type: 'ready', msg: 'other issue event' }),
      ].join('\n'),
    );
    writeFileSync(
      costsFile,
      [
        JSON.stringify({
          ts: '2026-07-28T02:00:00.000Z',
          issue: '137',
          task: 'plan',
          model: 'x',
          inputTokens: 1,
          outputTokens: 1,
          cost: 100,
        }),
        JSON.stringify({
          ts: '2026-07-28T02:28:00.000Z',
          issue: '137',
          task: 'plan',
          model: 'x',
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.01,
        }),
        JSON.stringify({
          ts: '2026-07-28T02:28:30.000Z',
          issue: '999',
          task: 'plan',
          model: 'x',
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.5,
        }),
      ].join('\n'),
    );
    return { eventsFile, costsFile, artifactsDir, workspace };
  }

  it('writes manifest.json, request.json, events.ndjson, and diff.patch with fixed names', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();

    const result = await writeBenchmarkArtifacts(
      {
        issue: 137,
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace,
        request: workRequest,
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async (command) => {
          if (command === 'git status --short') return { stdout: 'M widget.ts\n', stderr: '' };
          if (command === 'git diff --stat origin/main...HEAD') return { stdout: 'widget.ts | 2 ++\n', stderr: '' };
          if (command === 'git diff origin/main...HEAD')
            return { stdout: 'diff --git a/widget.ts b/widget.ts\n', stderr: '' };
          throw new Error(`unexpected command: ${command}`);
        },
      },
    );

    expect(existsSync(join(artifactsDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(artifactsDir, 'request.json'))).toBe(true);
    expect(existsSync(join(artifactsDir, 'events.ndjson'))).toBe(true);
    expect(existsSync(join(artifactsDir, 'diff.patch'))).toBe(true);

    const manifestOnDisk = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    expect(manifestOnDisk).toEqual(result.manifest);
    expect(manifestOnDisk.manifestVersion).toBe(1);
    expect(manifestOnDisk.cost.totalUsd).toBeCloseTo(0.01);

    const eventsOnDisk = readFileSync(join(artifactsDir, 'events.ndjson'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(eventsOnDisk).toHaveLength(2);
    expect(eventsOnDisk.every((e: any) => e.issue === '137')).toBe(true);

    const requestOnDisk = JSON.parse(readFileSync(join(artifactsDir, 'request.json'), 'utf-8'));
    expect(requestOnDisk).toEqual(workRequest);

    const diffOnDisk = readFileSync(join(artifactsDir, 'diff.patch'), 'utf-8');
    expect(diffOnDisk).toContain('diff --git a/widget.ts b/widget.ts');
  });

  it('writes an empty request.json object when no request is provided', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();

    await writeBenchmarkArtifacts(
      {
        issue: 137,
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'failed',
        workspace,
        failure: { phase: 'check', reason: 'fail', message: 'boom' },
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async () => ({ stdout: '', stderr: '' }),
      },
    );

    expect(JSON.parse(readFileSync(join(artifactsDir, 'request.json'), 'utf-8'))).toEqual({});
  });

  it('uses the captured diffBase SHA when origin/main cannot be resolved', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    const result = await writeBenchmarkArtifacts(
      {
        issue: 137,
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace,
        diffBase: sha,
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async (command) => {
          if (command.includes('origin/main')) throw new Error('unknown revision origin/main');
          if (command === 'git status --short') return { stdout: '', stderr: '' };
          if (command === `git diff --stat ${sha}..HEAD`) return { stdout: 'app.py | 1 +\n', stderr: '' };
          if (command === `git diff ${sha}..HEAD`)
            return {
              stdout: 'diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\ndiff --git a/README.md b/README.md\n',
              stderr: '',
            };
          throw new Error(`unexpected command: ${command}`);
        },
      },
    );

    expect(result.manifest.git.diffBase).toBe(sha);
    expect(result.manifest.git.diffStat).toBe('app.py | 1 +');
    const diffOnDisk = readFileSync(join(artifactsDir, 'diff.patch'), 'utf-8');
    expect(diffOnDisk).toContain('app.py');
    expect(diffOnDisk).toContain('README.md');
  });

  it('keeps origin/main as the diffBase precedent over a captured SHA', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    const result = await writeBenchmarkArtifacts(
      {
        issue: 137,
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace,
        diffBase: sha,
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async (command) => {
          if (command === 'git status --short') return { stdout: '', stderr: '' };
          if (command === 'git diff --stat origin/main...HEAD') return { stdout: 'widget.ts | 2 ++\n', stderr: '' };
          if (command === 'git diff origin/main...HEAD')
            return { stdout: 'diff --git a/widget.ts b/widget.ts\n', stderr: '' };
          throw new Error(`unexpected command: ${command}`);
        },
      },
    );

    expect(result.manifest.git.diffBase).toBe('origin/main...HEAD');
  });

  it('falls back to diffBase none and empty git fields when all git commands throw', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();

    const result = await writeBenchmarkArtifacts(
      {
        issue: 137,
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace,
        diffBase: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async () => {
          throw new Error('git not available');
        },
      },
    );

    expect(result.manifest.git).toEqual({ changedFiles: [], diffStat: '', diffBase: 'none' });
  });
});
