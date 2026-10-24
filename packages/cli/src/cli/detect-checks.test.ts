// packages/cli/src/cli/detect-checks.test.ts — `factory init --detect-checks`

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { getFactoryPaths } from '@on-par/factory-core';
import { resolveTestsCommand } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectChecksForInit,
  detectChecksIo,
  runDetectChecks,
  type DetectChecksDeps,
  type DryRunResult,
} from './detect-checks.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

const FIXTURE = fileURLToPath(new URL('./__fixtures__/dotnet-readme-tests', import.meta.url));

/** A writable copy of the .NET fixture with an initialized `.factory/config.json`. */
function dotnetRepo(): { dir: string; configPath: string } {
  const dir = tmp.makeSync('detect-checks-dotnet-');
  cpSync(FIXTURE, dir, { recursive: true });
  mkdirSync(join(dir, '.factory'));
  const configPath = join(dir, '.factory', 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: 2, checks: { lint: 'dotnet format --verify-no-changes' } }));
  return { dir, configPath };
}

function deps(dir: string, configPath: string, over: Partial<DetectChecksDeps> = {}) {
  const lines: string[] = [];
  const dryRuns: string[][] = [];
  const questions: string[] = [];
  const d: DetectChecksDeps = {
    repoRoot: dir,
    configPath,
    yes: true,
    dryRun: async (argv): Promise<DryRunResult> => (dryRuns.push(argv), { ok: true, summary: 'exit 0 in 1s' }),
    confirm: async (q) => (questions.push(q), true),
    log: (line) => lines.push(line),
    ...over,
  };
  return { d, lines, dryRuns, questions };
}

const agentReply = JSON.stringify({
  build: 'dotnet build App.sln',
  test: 'pwsh ./.githooks/run-tests.ps1',
  lint: null,
  notes: 'README Testing section runs the githooks script',
});

describe('runDetectChecks on a .NET repo whose README runs pwsh ./.githooks/run-tests.ps1', () => {
  it('asks the agent (heuristics are ambiguous), dry-runs, writes checks, and CHECK resolves the test command', async () => {
    const { dir, configPath } = dotnetRepo();
    const prompts: string[] = [];
    const { d, dryRuns, lines } = deps(dir, configPath, { runAgent: async (p) => (prompts.push(p), agentReply) });

    const outcome = await runDetectChecks(d);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('pwsh ./.githooks/run-tests.ps1');
    expect(outcome.source).toBe('agent');
    expect(dryRuns).toEqual([
      ['dotnet', 'build', 'App.sln'],
      ['pwsh', './.githooks/run-tests.ps1'],
    ]);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).checks).toEqual({
      build: 'dotnet build App.sln',
      test: 'pwsh ./.githooks/run-tests.ps1',
      lint: 'dotnet format --verify-no-changes',
    });
    expect(lines.join('\n')).toContain('Heuristics are ambiguous');
    expect(await resolveTestsCommand({ worktree: dir })).toEqual({
      runner: 'config',
      argv: ['pwsh', './.githooks/run-tests.ps1'],
      label: 'checks.test',
      source: '.factory/config.json',
    });
  });

  it('without a model, the documented script still wins over the dotnet test guess', async () => {
    const { dir, configPath } = dotnetRepo();
    const outcome = await runDetectChecks(deps(dir, configPath).d);
    expect(outcome).toMatchObject({
      source: 'heuristics',
      written: { build: 'dotnet build App.sln', test: 'pwsh ./.githooks/run-tests.ps1' },
    });
    expect((await resolveTestsCommand({ worktree: dir })).argv).toEqual(['pwsh', './.githooks/run-tests.ps1']);
  });

  it('a failed or unusable agent reply falls back to the heuristics', async () => {
    const { dir, configPath } = dotnetRepo();
    const failing = deps(dir, configPath, {
      runAgent: async () => {
        throw new Error('no model reachable');
      },
    });
    expect((await runDetectChecks(failing.d)).source).toBe('heuristics');
    expect(failing.lines.join('\n')).toContain('no model reachable');
    const empty = deps(dir, configPath, { runAgent: async () => '{"build": null, "test": "a | b"}' });
    expect((await runDetectChecks(empty.d)).source).toBe('heuristics');
    expect(empty.lines.join('\n')).toContain('Dropped an agent proposal');
  });
});

describe('runDetectChecks confirmation and dry-runs', () => {
  it('a clear-cut repo skips the agent', async () => {
    const dir = tmp.makeSync('detect-checks-go-');
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    const configPath = join(dir, 'config.json');
    const agentCalls: string[] = [];
    const outcome = await runDetectChecks(deps(dir, configPath, { runAgent: async (p) => (agentCalls.push(p), '') }).d);
    expect(agentCalls).toEqual([]);
    expect(outcome.written).toEqual({ build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' });
  });

  it('--yes drops a command whose dry-run failed', async () => {
    const { dir, configPath } = dotnetRepo();
    const { d } = deps(dir, configPath, {
      dryRun: async (argv) => (argv[0] === 'pwsh' ? { ok: false, summary: 'exit 1' } : { ok: true, summary: 'ok' }),
    });
    expect((await runDetectChecks(d)).written).toEqual({
      build: 'dotnet build App.sln',
      lint: 'dotnet format --verify-no-changes',
    });
  });

  it('interactively, a failed dry-run is kept only when confirmed, and a declined write writes nothing', async () => {
    const { dir, configPath } = dotnetRepo();
    const before = readFileSync(configPath, 'utf-8');
    const { d, questions } = deps(dir, configPath, {
      yes: false,
      dryRun: async () => ({ ok: false, summary: 'exit 1' }),
      confirm: async (q) => (questions.push(q), q.startsWith('Keep test')),
    });
    const outcome = await runDetectChecks(d);
    expect(questions).toEqual([
      'Keep build `dotnet build App.sln` although its dry-run failed?',
      'Keep test `pwsh ./.githooks/run-tests.ps1` although its dry-run failed?',
      'Write checks (test: pwsh ./.githooks/run-tests.ps1) to .factory/config.json?',
    ]);
    expect(outcome.written).toBeNull();
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('fails loudly on a malformed config file instead of overwriting it', async () => {
    const { dir, configPath } = dotnetRepo();
    writeFileSync(configPath, '{ nope');
    await expect(runDetectChecks(deps(dir, configPath).d)).rejects.toThrow(/Failed to parse/);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ nope');
  });

  it('writes nothing when every dry-run fails or nothing is found', async () => {
    const { dir, configPath } = dotnetRepo();
    const failing = deps(dir, configPath, { dryRun: async () => ({ ok: false, summary: 'exit 1' }) });
    expect((await runDetectChecks(failing.d)).written).toBeNull();
    expect(failing.lines.join('\n')).toContain('nothing written');

    const empty = tmp.makeSync('detect-checks-empty-');
    const none = deps(empty, join(empty, 'config.json'));
    expect(await runDetectChecks(none.d)).toMatchObject({ proposal: {}, written: null });
    expect(none.lines.join('\n')).toContain('No build, test or lint command found');
  });
});

describe('detectChecksIo', () => {
  it('dry-runs for real in the repo root and reports the exit and output tail', async () => {
    const dir = tmp.makeSync('detect-checks-io-');
    const io = detectChecksIo(dir);
    expect(await io.dryRun([process.execPath, '-e', 'process.exit(0)'])).toMatchObject({ ok: true });
    const failed = await io.dryRun([process.execPath, '-e', 'console.error("boom"); process.exit(3)']);
    expect(failed).toEqual({ ok: false, summary: 'exit 3: boom' });
  });

  it('runs the agent on the detect_checks route only when a router is given', async () => {
    expect(detectChecksIo('/repo').runAgent).toBeUndefined();
    const calls: unknown[][] = [];
    const io = detectChecksIo('/repo', { run: async (...args) => (calls.push(args), { output: 'reply' }) });
    expect(await io.runAgent!('prompt')).toBe('reply');
    expect(calls).toEqual([['detect_checks', 'prompt', { worktree: '/repo', timeoutSeconds: 600 }]]);
  });

  it('answers no when stdin is not a TTY, and asks on a TTY', async () => {
    const tty = () => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      return { input, output: new PassThrough() };
    };
    const notTty = { input: new PassThrough(), output: new PassThrough() };
    expect(await detectChecksIo('.', undefined, notTty).confirm('Write?')).toBe(false);
    for (const [answer, expected] of [
      ['y\n', true],
      ['YES\n', true],
      ['\n', false],
    ] as const) {
      const streams = tty();
      const asked = detectChecksIo('.', undefined, streams).confirm('Write?');
      streams.input.write(answer);
      expect(await asked).toBe(expected);
    }
  });
});

describe('detectChecksForInit', () => {
  it('skips missing harness CLIs, asks the detect_checks route, and writes to the repo config', async () => {
    const dir = tmp.makeSync('detect-checks-init-');
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory', 'config.yaml'), 'version: 2\n');
    const tasks: string[] = [];
    let skipped = false;
    const router = {
      skipMissingHarnessClis: () => {
        skipped = true;
      },
      setCostSink: () => {},
      run: async (task: string) => (tasks.push(task), { output: '{"test": "node -e process.exitCode=0"}' }),
    };
    const outcome = await detectChecksForInit(dir, router, true);
    expect(skipped).toBe(true);
    expect(tasks).toEqual(['detect_checks']);
    expect(outcome.written).toEqual({ test: 'node -e process.exitCode=0' });
    expect(readFileSync(join(dir, '.factory', 'config.yaml'), 'utf-8')).toMatch(
      /checks:\n\s+test: node -e process.exitCode=0/,
    );
  });

  it('logs the detect_checks call to the cost ledger', async () => {
    const dir = tmp.makeSync('detect-checks-cost-');
    mkdirSync(join(dir, '.factory'));
    writeFileSync(join(dir, '.factory', 'config.yaml'), 'version: 2\n');
    let captured: Parameters<Parameters<typeof detectChecksForInit>[1]['setCostSink']>[0] | undefined;
    const router = {
      skipMissingHarnessClis: () => {},
      setCostSink: (sink: typeof captured) => {
        captured = sink;
      },
      run: async () => {
        captured?.({ task: 'detect_checks', model: 'm', inputTokens: 1, outputTokens: 1, cost: 0.01 });
        return { output: '{"test": "node -e process.exitCode=0"}' };
      },
    };
    await detectChecksForInit(dir, router, true);
    const rows = readFileSync(getFactoryPaths(dir).costs, 'utf-8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)).toMatchObject({ task: 'detect_checks', issue: '-' });
  });
});

describe('runDetectChecks on a package.json repo', () => {
  it('runDetectChecks on a package.json repo makes no detect_checks route call', async () => {
    const dir = tmp.makeSync('detect-checks-node-');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}');
    mkdirSync(join(dir, '.factory'));
    const configPath = join(dir, '.factory', 'config.json');
    writeFileSync(configPath, JSON.stringify({ version: 2 }));
    const calls: string[] = [];
    const router = {
      run: async (task: string): Promise<{ output: string }> => {
        calls.push(task);
        throw new Error('detect_checks route must not be called');
      },
    };
    const io = detectChecksIo(dir, router);
    const { d, lines } = deps(dir, configPath, {
      runAgent: io.runAgent,
      dryRun: async () => ({ ok: true, summary: 'ok' }),
    });
    const outcome = await runDetectChecks(d);
    expect(calls).toEqual([]);
    expect(outcome.source).toBe('heuristics');
    expect(outcome.written).toEqual({ test: 'npm test' });
    expect(lines.join('\n')).not.toMatch(/ambiguous/);
  });

  it('with nothing to declare, the closing message names the test command CHECK will run', async () => {
    const dir = tmp.makeSync('detect-checks-verify-');
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'verify.sh'), 'exit 0');
    const { d, lines } = deps(dir, join(dir, '.factory', 'config.json'));
    await runDetectChecks(d);
    const text = lines.join('\n');
    expect(text).toContain('CHECK will run `bash scripts/verify.sh --no-e2e`');
    expect(text).not.toContain('No build, test or lint command found');
  });
});
