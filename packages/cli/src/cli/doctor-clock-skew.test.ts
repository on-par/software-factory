// packages/cli/src/cli/doctor-clock-skew.test.ts — the `clock skew` doctor row (#3149)

import { describe, expect, it } from 'vitest';

import { clockSkewCheck, measureDoctorClockSkew } from './doctor-clock-skew.js';

describe('clockSkewCheck', () => {
  it('has no row when skew was not measured', () => {
    expect(clockSkewCheck({ measured: false }, 60_000)).toBeNull();
  });

  it('is an optional warning when the Date header could not be read', () => {
    expect(clockSkewCheck({ measured: true, skewMs: null }, 60_000)).toEqual({
      name: 'clock skew',
      ok: false,
      optional: true,
      detail: 'could not read the GitHub Date header',
      fix: 'check GitHub API reachability',
    });
  });

  it('passes within the threshold with the signed skew', () => {
    expect(clockSkewCheck({ measured: true, skewMs: 2000 }, 60_000)).toEqual({
      name: 'clock skew',
      ok: true,
      detail: 'local clock is +2s vs GitHub (max 60s)',
    });
  });

  it.each([
    [300_000, '+300'],
    [-300_000, '-300'],
  ])('is an optional warning above the threshold (%i ms)', (skewMs, signed) => {
    const row = clockSkewCheck({ measured: true, skewMs }, 60_000);
    expect(row).toMatchObject({ ok: false, optional: true });
    expect(row?.detail).toBe(`local clock is ${signed}s vs GitHub (max 60s); the stale-claim reaper refuses to reap`);
    expect(row?.fix).toContain('NTP');
  });
});

describe('measureDoctorClockSkew', () => {
  const date = (offsetMs: number) => new Date(Date.now() - offsetMs).toUTCString();

  it('is not measured without a token', async () => {
    const getOctokit = () => {
      throw new Error('unused');
    };
    expect(await measureDoctorClockSkew({ hasGitHubToken: () => false, getOctokit })).toEqual({ measured: false });
  });

  it('measures from the rate_limit Date header and maps a failed call to null', async () => {
    const ok = { rest: { rateLimit: { get: async () => ({ headers: { date: date(300_000) } }) } } };
    const res = await measureDoctorClockSkew({ hasGitHubToken: () => true, getOctokit: () => ok });
    expect(res.measured && res.skewMs).toBeGreaterThan(295_000);
    const bad = { rest: { rateLimit: { get: async () => Promise.reject(new Error('down')) } } };
    expect(await measureDoctorClockSkew({ hasGitHubToken: () => true, getOctokit: () => bad })).toEqual({
      measured: true,
      skewMs: null,
    });
  });
});
