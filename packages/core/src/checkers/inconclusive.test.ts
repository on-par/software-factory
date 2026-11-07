import { mkdir } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { describeInconclusive, inconclusiveCause, inconclusiveOutputCause } from './inconclusive.js';
import { compileChecker, lintChecker, testsChecker } from './index.js';

describe('inconclusiveCause', () => {
  it.each([
    [{ timedOut: true, exitCode: 1 }, 'timeout'],
    [{ exitCode: 78 }, 'environment'],
    [{ exitCode: 126 }, 'missing-command'],
    [{ exitCode: 127 }, 'missing-command'],
    [{ exitCode: -1 }, 'killed'],
    [{ checkerError: true, exitCode: 1 }, 'checker-error'],
  ] as const)('%o is %s', (fail, cause) => {
    expect(inconclusiveCause(fail)).toBe(cause);
  });

  // A signal inside the verify shell (137 SIGKILL, 143 SIGTERM) can be a real crash: it stays red.
  it.each([{ exitCode: 1 }, { exitCode: 2 }, { exitCode: 137 }, { exitCode: 143 }, {}])(
    '%o is a genuine failure',
    (fail) => {
      expect(inconclusiveCause(fail)).toBeUndefined();
    },
  );
});

describe('describeInconclusive', () => {
  it('names each cause', () => {
    expect(describeInconclusive('timeout', undefined, 300)).toBe('timeout after 300s');
    expect(describeInconclusive('timeout')).toBe('timeout');
    expect(describeInconclusive('environment', 78)).toBe('environment error (exit 78)');
    expect(describeInconclusive('missing-command', 127)).toBe('command not found or not executable (exit 127)');
    expect(describeInconclusive('killed')).toBe('no exit code (killed by a signal or failed to start)');
    expect(describeInconclusive('checker-error')).toBe('the checker crashed before a verdict');
  });
});

describe('inconclusiveOutputCause', () => {
  const fail = { checker: 'tests', result: 'FAIL' as const, details: 'x' };

  it('reads the recorded command, the checker crash flag and the timeout flag', () => {
    expect(
      inconclusiveOutputCause({ ...fail, failedCommand: { command: 'c', exitCode: 127, timeoutSeconds: 1 } }),
    ).toBe('missing-command');
    expect(inconclusiveOutputCause({ ...fail, checkerError: true })).toBe('checker-error');
    expect(inconclusiveOutputCause({ ...fail, timedOut: true })).toBe('timeout');
  });

  it('classifies FAILs recorded before failedCommand existed (sandbox marker, checker crash, missing pwsh)', () => {
    expect(inconclusiveOutputCause({ ...fail, sandboxEnv: 'verify: ENVIRONMENT ERROR: x' })).toBe('environment');
    expect(inconclusiveOutputCause({ ...fail, details: 'unexpected checker error: boom' })).toBe('checker-error');
    expect(
      inconclusiveOutputCause({ ...fail, details: 'verify.ps1 failed: pwsh (PowerShell 7) is not on PATH — x' }),
    ).toBe('missing-command');
  });

  it('a genuine FAIL or a PASS is not inconclusive', () => {
    expect(inconclusiveOutputCause({ ...fail, failedCommand: { command: 'c', exitCode: 1, timeoutSeconds: 1 } })).toBe(
      undefined,
    );
    expect(inconclusiveOutputCause({ ...fail, details: 'FAIL src/a.test.ts' })).toBeUndefined();
    expect(inconclusiveOutputCause({ checker: 'tests', result: 'PASS', details: '', checkerError: true })).toBe(
      undefined,
    );
  });
});

describe('a checker crash is flagged, so base health reads it as inconclusive', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());

  it.each([
    ['compile', compileChecker],
    ['tests', testsChecker],
    ['lint', lintChecker],
  ] as const)('%s: an unreadable package.json is a FAIL with checkerError', async (_name, checker) => {
    const worktree = await tempDirs.make('checker-crash-');
    await mkdir(`${worktree}/package.json`);
    const out = await checker({ worktree, specPath: '', env: {} });
    expect(out.result).toBe('FAIL');
    expect(out.details).toMatch(/^unexpected checker error:/);
    expect(out.checkerError).toBe(true);
    expect(inconclusiveOutputCause(out)).toBe('checker-error');
  });
});
