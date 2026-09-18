import { describe, expect, it } from 'vitest';
import {
  formatStopFileAge,
  readStopFileStatus,
  stopSentinelCheck,
  stopSentinelRunSkipMessage,
} from './stop-sentinel.js';

describe('readStopFileStatus', () => {
  it('returns present:false when the file does not exist', () => {
    const status = readStopFileStatus({ stop: '/repo/.factory/STOP' }, { pathExists: () => false });
    expect(status).toEqual({ present: false });
  });

  it('returns present:true with ageMs/writtenAt computed from injected deps', () => {
    const mtime = 1_000_000;
    const now = mtime + 65_000;
    const status = readStopFileStatus(
      { stop: '/repo/.factory/STOP' },
      { pathExists: () => true, statMtimeMs: () => mtime, now: () => now },
    );
    expect(status).toEqual({ present: true, ageMs: 65_000, writtenAt: new Date(mtime).toISOString() });
  });

  it('falls back to age 0 / unknown writtenAt when stat throws', () => {
    const status = readStopFileStatus(
      { stop: '/repo/.factory/STOP' },
      {
        pathExists: () => true,
        statMtimeMs: () => {
          throw new Error('gone');
        },
      },
    );
    expect(status).toEqual({ present: true, ageMs: 0, writtenAt: 'unknown' });
  });
});

describe('formatStopFileAge', () => {
  it('formats sub-second ages in milliseconds', () => {
    expect(formatStopFileAge(999)).toBe('999ms');
  });

  it('formats a boundary second as seconds', () => {
    expect(formatStopFileAge(1000)).toBe('1s');
  });

  it('formats minutes and seconds', () => {
    expect(formatStopFileAge(65_000)).toBe('1m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatStopFileAge(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m');
  });
});

describe('stopSentinelRunSkipMessage', () => {
  it('returns an empty string when STOP is absent', () => {
    expect(stopSentinelRunSkipMessage({ present: false })).toBe('');
  });

  it('includes the age and resume guidance when STOP is present', () => {
    const msg = stopSentinelRunSkipMessage({ present: true, ageMs: 65_000, writtenAt: '2026-09-17T00:00:00.000Z' });
    expect(msg).toContain('.factory/STOP present');
    expect(msg).toContain('1m 5s');
    expect(msg).toContain('factory resume');
  });
});

describe('stopSentinelCheck', () => {
  it('returns ok:true with no fix when STOP is absent', () => {
    const check = stopSentinelCheck({ present: false });
    expect(check.ok).toBe(true);
    expect(check.fix).toBeUndefined();
  });

  it('returns ok:false, optional:true with a fix mentioning factory resume when STOP is present', () => {
    const check = stopSentinelCheck({ present: true, ageMs: 65_000, writtenAt: '2026-09-17T00:00:00.000Z' });
    expect(check.ok).toBe(false);
    expect(check.optional).toBe(true);
    expect(check.fix).toContain('factory resume');
    expect(check.detail).toContain('.factory/STOP present');
  });
});
