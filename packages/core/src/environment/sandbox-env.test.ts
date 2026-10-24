import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../types/index.js';
import {
  ENV_ERROR_PREFIX,
  VERIFY_SANDBOX_ENV_EXIT,
  VERIFY_SANDBOX_ENV_MARKER,
  envErrorLine,
  sandboxEnvFromSummary,
  sandboxEnvMarkerLine,
  sandboxEnvParkMessage,
} from './sandbox-env.js';

function summary(results: CheckSummary['results']): CheckSummary {
  return { failures: results.length, passes: 0, skips: 0, total: results.length, results };
}

describe('envErrorLine', () => {
  it('returns the first line starting with the prefix, trimmed at the end', () => {
    const output = `working\n${ENV_ERROR_PREFIX} ${VERIFY_SANDBOX_ENV_MARKER}  \nmore`;
    expect(envErrorLine(output)).toBe(`${ENV_ERROR_PREFIX} ${VERIFY_SANDBOX_ENV_MARKER}`);
  });

  it('ignores the prefix mid-line and empty output', () => {
    expect(envErrorLine(`note ${ENV_ERROR_PREFIX} later`)).toBeUndefined();
    expect(envErrorLine('')).toBeUndefined();
  });
});

describe('sandboxEnvMarkerLine', () => {
  const base = { exitCode: VERIFY_SANDBOX_ENV_EXIT, stdout: '', stderr: '' };

  it('returns the marker for exit 78 with the marker on stdout or stderr', () => {
    expect(sandboxEnvMarkerLine({ ...base, stdout: `${VERIFY_SANDBOX_ENV_MARKER}\n` })).toBe(VERIFY_SANDBOX_ENV_MARKER);
    expect(sandboxEnvMarkerLine({ ...base, stderr: `x\n${VERIFY_SANDBOX_ENV_MARKER}` })).toBe(
      VERIFY_SANDBOX_ENV_MARKER,
    );
  });

  it('returns undefined for exit 78 without the marker', () => {
    expect(sandboxEnvMarkerLine({ ...base, stdout: 'boom' })).toBeUndefined();
  });

  it('returns undefined for another exit code carrying the marker', () => {
    expect(sandboxEnvMarkerLine({ exitCode: 1, stdout: VERIFY_SANDBOX_ENV_MARKER, stderr: '' })).toBeUndefined();
  });
});

describe('sandboxEnvFromSummary', () => {
  it('reads the marker off a failing tests result', () => {
    const s = summary([{ checker: 'tests', result: 'FAIL', details: 'x', sandboxEnv: VERIFY_SANDBOX_ENV_MARKER }]);
    expect(sandboxEnvFromSummary(s)).toBe(VERIFY_SANDBOX_ENV_MARKER);
  });

  it('is undefined without a tagged tests FAIL', () => {
    expect(sandboxEnvFromSummary(summary([{ checker: 'tests', result: 'FAIL', details: 'x' }]))).toBeUndefined();
    expect(
      sandboxEnvFromSummary(summary([{ checker: 'lint', result: 'FAIL', details: 'x', sandboxEnv: 'm' }])),
    ).toBeUndefined();
  });
});

describe('sandboxEnvParkMessage', () => {
  it('names the phase, the line and #3081', () => {
    expect(sandboxEnvParkMessage('build', 'L')).toMatch(/^BUILD hit a sandbox environment error: L .*#3081/);
    expect(sandboxEnvParkMessage('check', 'L')).toMatch(/^CHECK tests hit/);
  });
});
