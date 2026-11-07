import { describe, expect, it } from 'vitest';

import { describeInconclusive, inconclusiveCause } from './inconclusive.js';

describe('inconclusiveCause', () => {
  it.each([
    [{ timedOut: true, exitCode: 1 }, 'timeout'],
    [{ exitCode: 78 }, 'environment'],
    [{ exitCode: 126 }, 'missing-command'],
    [{ exitCode: 127 }, 'missing-command'],
    [{ exitCode: -1 }, 'killed'],
  ] as const)('%o is %s', (fail, cause) => {
    expect(inconclusiveCause(fail)).toBe(cause);
  });

  it.each([{ exitCode: 1 }, { exitCode: 2 }, {}])('%o is a genuine failure', (fail) => {
    expect(inconclusiveCause(fail)).toBeUndefined();
  });
});

describe('describeInconclusive', () => {
  it('names each cause', () => {
    expect(describeInconclusive('timeout', undefined, 300)).toBe('timeout after 300s');
    expect(describeInconclusive('timeout')).toBe('timeout');
    expect(describeInconclusive('environment', 78)).toBe('environment error (exit 78)');
    expect(describeInconclusive('missing-command', 127)).toBe('command not found or not executable (exit 127)');
    expect(describeInconclusive('killed')).toBe('no exit code (killed by a signal or failed to start)');
  });
});
