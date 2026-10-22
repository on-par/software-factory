import { describe, expect, it } from 'vitest';

import {
  envErrorLine,
  sandboxEnvFailure,
  sandboxEnvMarkerLine,
  sandboxEnvParkMessage,
  VERIFY_ENV_MARKER,
} from './sandbox-env.js';

const run = (exitCode: number, stdout: string, stderr = '') => ({ exitCode, stdout, stderr });

describe('sandboxEnvMarkerLine (#3332)', () => {
  it('returns the marker with the following EPERM detail on exit 78', () => {
    const out = `${VERIFY_ENV_MARKER}\nverify: EPERM: tcp 127.0.0.1: listen EPERM\n`;
    expect(sandboxEnvMarkerLine(run(78, out))).toBe(
      `${VERIFY_ENV_MARKER} — verify: EPERM: tcp 127.0.0.1: listen EPERM`,
    );
  });

  it('returns the bare marker when no detail line follows', () => {
    expect(sandboxEnvMarkerLine(run(78, `${VERIFY_ENV_MARKER}\n`))).toBe(VERIFY_ENV_MARKER);
  });

  it('finds the marker in stderr', () => {
    expect(sandboxEnvMarkerLine(run(78, '', VERIFY_ENV_MARKER))).toBe(VERIFY_ENV_MARKER);
  });

  it('ignores exit 78 without the marker and the marker on another exit code', () => {
    expect(sandboxEnvMarkerLine(run(78, 'something else'))).toBeUndefined();
    expect(sandboxEnvMarkerLine(run(1, VERIFY_ENV_MARKER))).toBeUndefined();
  });
});

describe('envErrorLine (#3332)', () => {
  it('returns the first line that starts with ENV-ERROR:', () => {
    expect(envErrorLine(`working\nENV-ERROR: ${VERIFY_ENV_MARKER}\nENV-ERROR: later\n`)).toBe(
      `ENV-ERROR: ${VERIFY_ENV_MARKER}`,
    );
  });

  it('ignores ENV-ERROR: mid-line and empty output', () => {
    expect(envErrorLine('note: ENV-ERROR: not a line start')).toBeUndefined();
    expect(envErrorLine('')).toBeUndefined();
  });
});

describe('sandboxEnvParkMessage / sandboxEnvFailure (#3332)', () => {
  it('names the phase, the line and #3081', () => {
    const msg = sandboxEnvParkMessage('CHECK', 'the line');
    expect(msg).toContain('CHECK hit a sandbox environment error: the line');
    expect(msg).toContain('#3081');
  });

  it('picks the marker of a FAIL result only', () => {
    expect(
      sandboxEnvFailure([
        { result: 'PASS', sandboxEnv: 'x' },
        { result: 'FAIL', sandboxEnv: 'y' },
      ]),
    ).toBe('y');
    expect(sandboxEnvFailure([{ result: 'FAIL' }])).toBeUndefined();
  });
});
