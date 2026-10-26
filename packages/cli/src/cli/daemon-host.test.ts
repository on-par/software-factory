import { describe, expect, it } from 'vitest';

import { DaemonCtlError, resolveFactorydConfig, type InstallInfo } from './daemon.js';

const install: InstallInfo = { kind: 'unknown', prefix: '/p', version: '1.0.0' };
const resolve = (env: NodeJS.ProcessEnv) => resolveFactorydConfig({ registry: '/tmp/r.json' }, { install, env });

describe('resolveFactorydConfig FACTORYD_HOST', () => {
  it('resolveFactorydConfig refuses a non-loopback FACTORYD_HOST naming ADR-0034', () => {
    let caught: unknown;
    try {
      resolve({ FACTORYD_HOST: '0.0.0.0' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonCtlError);
    expect((caught as DaemonCtlError).code).toBe(2);
    expect((caught as DaemonCtlError).message).toMatch(/ADR-0034/);
  });

  it('accepts ::1', () => {
    expect(resolve({ FACTORYD_HOST: '::1' }).host).toBe('::1');
  });

  it('treats whitespace-only as unset', () => {
    expect(resolve({ FACTORYD_HOST: '  ' }).host).toBe('127.0.0.1');
  });

  it('trims surrounding whitespace', () => {
    expect(resolve({ FACTORYD_HOST: ' localhost ' }).host).toBe('localhost');
  });
});
