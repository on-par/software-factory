import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRunBriefArgs, runFactory } from './invoke.js';
import type { ExecFn } from './workspace.js';

describe('buildRunBriefArgs', () => {
  it('builds the run-brief argv in order', () => {
    const args = buildRunBriefArgs({
      briefPath: '/artifacts/calculator/1/brief.md',
      workspace: '/tmp/ws',
      artifactsDir: '/artifacts/calculator/1',
    });

    expect(args).toEqual([
      'run-brief',
      '/artifacts/calculator/1/brief.md',
      '--workspace',
      '/tmp/ws',
      '--artifacts',
      '/artifacts/calculator/1',
    ]);
  });
});

describe('runFactory', () => {
  const originalFactoryBin = process.env.FACTORY_BIN;

  beforeEach(() => {
    delete process.env.FACTORY_BIN;
  });

  afterEach(() => {
    if (originalFactoryBin === undefined) delete process.env.FACTORY_BIN;
    else process.env.FACTORY_BIN = originalFactoryBin;
  });

  it('defaults to the bare "factory" binary and runs with cwd = workspace', async () => {
    const calls: { argv: readonly string[]; cwd: string }[] = [];
    const exec: ExecFn = async (argv, opts) => {
      calls.push({ argv, cwd: opts.cwd });
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await runFactory(['run-brief', 'brief.md'], { cwd: '/tmp/ws' }, { exec });

    expect(calls).toEqual([{ argv: ['factory', 'run-brief', 'brief.md'], cwd: '/tmp/ws' }]);
  });

  it('prefers opts.factoryBin over FACTORY_BIN over the default', async () => {
    process.env.FACTORY_BIN = 'factory-from-env';
    const calls: (readonly string[])[] = [];
    const exec: ExecFn = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await runFactory(['run-brief'], { cwd: '/tmp/ws', factoryBin: '/opt/factory' }, { exec });
    expect(calls[0][0]).toBe('/opt/factory');

    await runFactory(['run-brief'], { cwd: '/tmp/ws' }, { exec });
    expect(calls[1][0]).toBe('factory-from-env');
  });

  it('surfaces a non-zero exit as a result, not a thrown error', async () => {
    const exec: ExecFn = async () => ({ exitCode: 1, stdout: 'out', stderr: 'parked' });

    const result = await runFactory(['run-brief'], { cwd: '/tmp/ws' }, { exec });

    expect(result).toEqual({ exitCode: 1, stdout: 'out', stderr: 'parked' });
  });
});
