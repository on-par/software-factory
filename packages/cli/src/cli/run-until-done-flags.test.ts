import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import { PROGRAM_HANDLERS, type ProgramHandlers } from './index.js';
import { registerRunWorkCommands } from './program-run-work.js';
import { parseWaitMode, validateUntilDoneFlags, type UntilDoneFlagOptions } from './run-until-done.js';

const exitCode = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof CliExitError ? err.code : undefined;
  }
  return undefined;
};

describe('parseWaitMode', () => {
  it('wait defaults to stay', () => {
    expect(parseWaitMode(undefined)).toBe('stay');
    expect(parseWaitMode('stay')).toBe('stay');
    expect(parseWaitMode('exit')).toBe('exit');
  });

  it('rejects an unknown wait mode with exit 2', () => {
    expect(exitCode(() => parseWaitMode('forever'))).toBe(2);
    expect(() => parseWaitMode('')).toThrow('factory: --wait must be stay or exit');
  });
});

describe('validateUntilDoneFlags', () => {
  it('lifecycle-only flags without --issue exit 2', () => {
    const flagged: UntilDoneFlagOptions[] = [
      { wait: 'exit' },
      { maxWait: '30m' },
      { admin: true },
      { json: true },
      { export: '/tmp/out' },
    ];
    for (const opts of flagged) {
      expect(exitCode(() => validateUntilDoneFlags(opts))).toBe(2);
      expect(() => validateUntilDoneFlags(opts)).toThrow('need --issue');
    }
  });

  it('plain run flags pass without --issue', () => {
    expect(validateUntilDoneFlags({})).toEqual({ wait: 'stay', maxWaitMs: undefined });
    expect(validateUntilDoneFlags({ localQueue: true, maxLanes: '2' })).toEqual({ wait: 'stay', maxWaitMs: undefined });
  });

  it('--issue with --local-queue or --max-lanes exits 2', () => {
    expect(exitCode(() => validateUntilDoneFlags({ issue: '12', localQueue: true }))).toBe(2);
    expect(exitCode(() => validateUntilDoneFlags({ issue: '12', maxLanes: '2' }))).toBe(2);
  });

  it('--issue parses wait and max-wait', () => {
    expect(validateUntilDoneFlags({ issue: '12' })).toEqual({ wait: 'stay', maxWaitMs: undefined });
    expect(validateUntilDoneFlags({ issue: '12', wait: 'exit', maxWait: '30m' })).toEqual({
      wait: 'exit',
      maxWaitMs: 1_800_000,
    });
    expect(exitCode(() => validateUntilDoneFlags({ issue: '12', wait: 'nope' }))).toBe(2);
  });

  it('an invalid --max-wait names --max-wait, not --merge-timeout', () => {
    expect(() => validateUntilDoneFlags({ issue: '12', maxWait: '5x' })).toThrow(/--max-wait must be a positive/);
    expect(exitCode(() => validateUntilDoneFlags({ issue: '12', maxWait: '5x' }))).toBe(2);
  });

  it('--export needs a directory', () => {
    expect(exitCode(() => validateUntilDoneFlags({ issue: '12', export: '' }))).toBe(2);
  });
});

function dispatch(argv: string[]) {
  const cmdRun = vi.fn<ProgramHandlers['cmdRun']>(async () => {});
  const cmdRunUntilDone = vi.fn<ProgramHandlers['cmdRunUntilDone']>(async () => {});
  const program = new Command().exitOverride();
  registerRunWorkCommands(program, { ...PROGRAM_HANDLERS, cmdRun, cmdRunUntilDone });
  return { cmdRun, cmdRunUntilDone, parsed: program.parseAsync(['node', 'factory', 'run', ...argv]) };
}

describe('factory run dispatch', () => {
  it('run without --issue calls cmdRun with the same options', async () => {
    const { cmdRun, cmdRunUntilDone, parsed } = dispatch(['--local-queue', '--no-auto-merge', '--max-lanes', '2']);
    await parsed;
    expect(cmdRun).toHaveBeenCalledWith({ localQueue: true, autoMerge: false, maxLanes: '2' });
    expect(cmdRunUntilDone).not.toHaveBeenCalled();
  });

  it('run --issue 12 --wait exit calls cmdRunUntilDone', async () => {
    const { cmdRun, cmdRunUntilDone, parsed } = dispatch(['--issue', '12', '--wait', 'exit', '--max-wait', '1h']);
    await parsed;
    expect(cmdRunUntilDone).toHaveBeenCalledWith(12, { issue: '12', wait: 'exit', maxWait: '1h' });
    expect(cmdRun).not.toHaveBeenCalled();
  });

  it('lifecycle-only flags without --issue exit 2 and never call cmdRun', async () => {
    const { cmdRun, parsed } = dispatch(['--wait', 'exit']);
    await expect(parsed).rejects.toMatchObject({ code: 2 });
    expect(cmdRun).not.toHaveBeenCalled();
  });
});
