import { describe, expect, it, vi } from 'vitest';

import { AdapterError, type CheckpointResult } from './checkpoint.js';
import { defaultCliDeps, main, type CliDeps } from './cli-run.js';

const RESULT: CheckpointResult = {
  outcome: 'ready',
  workspace: '/tmp/ws',
  artifactsDir: '/tmp/artifacts/calculator/1',
  briefPath: '/tmp/artifacts/calculator/1/brief.md',
  manifestPath: '/tmp/artifacts/calculator/1/manifest.json',
};

function fakeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    readTaskFile: vi.fn(async () => 'do the thing'),
    runCheckpoint: vi.fn(async () => RESULT),
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
});
