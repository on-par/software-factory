import { describe, expect, it, vi } from 'vitest';

import type { BaselineTrial } from './baseline.js';
import { AdapterError, type CheckpointResult } from './checkpoint.js';
import { defaultCliDeps, main, type CliDeps } from './cli-run.js';
import { minimalManifest } from './manifest-fixture.js';

const RESULT: CheckpointResult = {
  outcome: 'ready',
  workspace: '/tmp/ws',
  artifactsDir: '/tmp/artifacts/calculator/1',
  briefPath: '/tmp/artifacts/calculator/1/brief.md',
  manifestPath: '/tmp/artifacts/calculator/1/manifest.json',
};

const VALID_CONFIG_JSON = JSON.stringify({
  baselineId: 'test-baseline',
  factory: { repo: 'https://example.com/repo', commit: 'a'.repeat(40), packageVersion: '2.0.0' },
  scbench: { repo: 'https://example.com/scbench', commit: 'b'.repeat(40), pinnedAt: '2026-07-28' },
  modelConfig: { source: 'models.json', env: {} },
  promptInputs: 'briefs',
  environment: { node: '>=20', requiredBinaries: [], hostClass: 'test', scbenchHarness: 'python' },
  problems: { selection: 'deterministic', smoke: 'first', suite: 'first three' },
  trials: { smokeRuns: 2, suiteTrialsPerProblem: 3 },
  comparisonThreshold: 10,
});

function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    readTaskFile: vi.fn(async () => 'do the thing'),
    runCheckpoint: vi.fn(async () => RESULT),
    readBaselineConfig: vi.fn(async () => VALID_CONFIG_JSON),
    collectBaselineTrials: vi.fn((): BaselineTrial[] => []),
    writeReport: vi.fn(async () => undefined),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

describe('cli-run main', () => {
  it('prints usage and exits 2 for an unknown/missing subcommand', async () => {
    const deps = fakeDeps();

    const code = await main([], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('usage:'));
  });

  it('exits 2 when required flags are missing', async () => {
    const deps = fakeDeps();

    const code = await main(['run-checkpoint', '--workspace', '/tmp/ws'], deps);

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required flag'));
  });

  it('ignores stray non-flag tokens and a flag immediately followed by another flag', async () => {
    const deps = fakeDeps();

    const code = await main(
      [
        'run-checkpoint',
        'stray-positional',
        '--index',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.runCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }), {
      workspace: '/tmp/ws',
      artifactsRoot: '/tmp/artifacts',
      factoryBin: undefined,
    });
  });

  it('ignores a dangling flag with no trailing value at the end of argv', async () => {
    const deps = fakeDeps();

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
        '--factory-bin',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.runCheckpoint).toHaveBeenCalledWith(expect.anything(), {
      workspace: '/tmp/ws',
      artifactsRoot: '/tmp/artifacts',
      factoryBin: undefined,
    });
  });

  it('parses flags, reads the task file, and prints the CheckpointResult as JSON on success', async () => {
    const deps = fakeDeps();

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
        '--index',
        '0',
        '--factory-bin',
        '/opt/factory',
      ],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.readTaskFile).toHaveBeenCalledWith('/tmp/task.md');
    expect(deps.runCheckpoint).toHaveBeenCalledWith(
      { problemId: 'calculator', checkpointId: '1', index: 0, task: 'do the thing' },
      { workspace: '/tmp/ws', artifactsRoot: '/tmp/artifacts', factoryBin: '/opt/factory' },
    );
    expect(deps.log).toHaveBeenCalledWith(JSON.stringify(RESULT));
  });

  it('defaults --index to 0 when omitted', async () => {
    const deps = fakeDeps();

    await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(deps.runCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }), expect.anything());
  });

  it('exits 2 when the task file cannot be read', async () => {
    const deps = fakeDeps({ readTaskFile: vi.fn(async () => Promise.reject(new Error('ENOENT'))) });

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/missing.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('exits 2 when runCheckpoint throws an AdapterError', async () => {
    const deps = fakeDeps({
      runCheckpoint: vi.fn(async () => {
        throw new AdapterError('workspace unwritable');
      }),
    });

    const code = await main(
      [
        'run-checkpoint',
        '--workspace',
        '/tmp/ws',
        '--artifacts',
        '/tmp/artifacts',
        '--task-file',
        '/tmp/task.md',
        '--problem',
        'calculator',
        '--checkpoint',
        '1',
      ],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith('workspace unwritable');
  });

  it('re-throws unexpected (non-AdapterError) errors', async () => {
    const deps = fakeDeps({
      runCheckpoint: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(
      main(
        [
          'run-checkpoint',
          '--workspace',
          '/tmp/ws',
          '--artifacts',
          '/tmp/artifacts',
          '--task-file',
          '/tmp/task.md',
          '--problem',
          'calculator',
          '--checkpoint',
          '1',
        ],
        deps,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('baseline-report subcommand', () => {
  it('prints usage and exits 2 when called with no subcommand at all', async () => {
    const deps = fakeDeps();
    const code = await main(['baseline-report'], deps);
    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required flag'));
  });

  it('exits 2 when required flags are missing', async () => {
    const deps = fakeDeps();
    const code = await main(['baseline-report', '--config', '/tmp/cfg.json'], deps);
    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required flag(s): --runs, --out'));
  });

  it('reads the config, collects trials, writes the report, and exits 0 on success', async () => {
    const deps = fakeDeps();

    const code = await main(
      ['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(0);
    expect(deps.readBaselineConfig).toHaveBeenCalledWith('/tmp/cfg.json');
    expect(deps.collectBaselineTrials).toHaveBeenCalledWith('/tmp/runs');
    expect(deps.writeReport).toHaveBeenCalledWith('/tmp/out.md', expect.stringContaining('test-baseline'));
    expect(deps.log).toHaveBeenCalledWith('wrote baseline report to /tmp/out.md');
  });

  it('renders trials returned by collectBaselineTrials into the written report', async () => {
    const trial: BaselineTrial = {
      id: 'smoke/trial-1',
      manifestPath: '/tmp/runs/smoke/trial-1/manifest.json',
      manifest: minimalManifest(),
    };
    const deps = fakeDeps({ collectBaselineTrials: vi.fn(() => [trial]) });

    await main(['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'], deps);

    expect(deps.writeReport).toHaveBeenCalledWith('/tmp/out.md', expect.stringContaining('smoke/trial-1'));
  });

  it('exits 2 when --config cannot be read', async () => {
    const deps = fakeDeps({
      readBaselineConfig: vi.fn(async () => Promise.reject(new Error('ENOENT'))),
    });

    const code = await main(
      ['baseline-report', '--config', '/tmp/missing.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('exits 2 when the config is structurally invalid', async () => {
    const deps = fakeDeps({ readBaselineConfig: vi.fn(async () => '{"not":"valid"}') });

    const code = await main(
      ['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('missing required field'));
  });

  it('exits 2 when collectBaselineTrials throws an AdapterError (invalid manifest under --runs)', async () => {
    const deps = fakeDeps({
      collectBaselineTrials: vi.fn(() => {
        throw new AdapterError('manifest version mismatch');
      }),
    });

    const code = await main(
      ['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'],
      deps,
    );

    expect(code).toBe(2);
    expect(deps.logError).toHaveBeenCalledWith('manifest version mismatch');
  });

  it('re-throws unexpected (non-AdapterError) errors from collectBaselineTrials', async () => {
    const deps = fakeDeps({
      collectBaselineTrials: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    await expect(
      main(['baseline-report', '--config', '/tmp/cfg.json', '--runs', '/tmp/runs', '--out', '/tmp/out.md'], deps),
    ).rejects.toThrow('boom');
  });
});

describe('defaultCliDeps', () => {
  it('logs to console.log/console.error and reads real files', async () => {
    const deps = defaultCliDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    deps.log('hello');
    deps.logError('oops');
    expect(logSpy).toHaveBeenCalledWith('hello');
    expect(errorSpy).toHaveBeenCalledWith('oops');

    await expect(deps.readTaskFile('/definitely/does/not/exist.md')).rejects.toThrow();

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reads a real baseline config and writes a real report file', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const deps = defaultCliDeps();
    const dir = mkdtempSync(join(tmpdir(), 'scb-cli-baseline-'));
    try {
      const configPath = join(dir, 'cfg.json');
      const outPath = join(dir, 'out.md');
      const raw = JSON.stringify({
        baselineId: 'x',
        factory: { repo: 'r', commit: 'a'.repeat(40), packageVersion: '1.0.0' },
        scbench: { repo: 'r', commit: 'b'.repeat(40), pinnedAt: '2026-07-28' },
        modelConfig: { source: 's', env: {} },
        promptInputs: 'p',
        environment: { node: '>=20', requiredBinaries: [], hostClass: 'h', scbenchHarness: 'p' },
        problems: { selection: 's', smoke: 's', suite: 's' },
        trials: { smokeRuns: 1, suiteTrialsPerProblem: 1 },
        comparisonThreshold: 10,
      });
      await deps.writeReport(configPath, raw);
      expect(await deps.readBaselineConfig(configPath)).toBe(raw);
      await deps.writeReport(outPath, 'report content');
      expect(readFileSync(outPath, 'utf-8')).toBe('report content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
