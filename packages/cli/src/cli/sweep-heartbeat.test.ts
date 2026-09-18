import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkSweepHeartbeat,
  defaultSweepHeartbeatDeps,
  formatSweepHeartbeatStatusLine,
  resolveSweepHeartbeatFile,
  sweepHeartbeatCheck,
  type SweepHeartbeatPolicy,
} from './sweep-heartbeat.js';

const BASE_POLICY: SweepHeartbeatPolicy = { loopIntervalSeconds: 300, staleThresholdMultiplier: 2 };

describe('resolveSweepHeartbeatFile', () => {
  it('returns undefined when neither config nor env set a path', () => {
    expect(resolveSweepHeartbeatFile(BASE_POLICY, {})).toBeUndefined();
  });

  it('falls back to HEARTBEAT_FILE env var when policy.heartbeatFile is unset', () => {
    expect(resolveSweepHeartbeatFile(BASE_POLICY, { HEARTBEAT_FILE: '/tmp/hb' })).toBe('/tmp/hb');
  });

  it('prefers policy.heartbeatFile over the env var', () => {
    expect(
      resolveSweepHeartbeatFile({ ...BASE_POLICY, heartbeatFile: '/configured/hb' }, { HEARTBEAT_FILE: '/tmp/hb' }),
    ).toBe('/configured/hb');
  });
});

describe('checkSweepHeartbeat', () => {
  it('returns unconfigured when no heartbeat file resolves', () => {
    const status = checkSweepHeartbeat(BASE_POLICY, {}, { exists: () => true, mtimeMs: () => 0, now: () => 0 });
    expect(status).toEqual({ status: 'unconfigured' });
  });

  it('returns missing when the resolved file does not exist', () => {
    const policy = { ...BASE_POLICY, heartbeatFile: '/does/not/exist' };
    const status = checkSweepHeartbeat(policy, {}, { exists: () => false, mtimeMs: () => 0, now: () => 0 });
    expect(status).toEqual({ status: 'missing', file: '/does/not/exist' });
  });

  it('returns fresh when age is at or below the threshold', () => {
    const policy = { ...BASE_POLICY, heartbeatFile: '/hb' };
    const now = 1_000_000;
    const mtime = now - 100_000; // 100s ago, threshold is 600s
    const status = checkSweepHeartbeat(policy, {}, { exists: () => true, mtimeMs: () => mtime, now: () => now });
    expect(status).toEqual({ status: 'fresh', file: '/hb', ageSeconds: 100, thresholdSeconds: 600 });
  });

  it('returns stale when age exceeds the threshold', () => {
    const policy = { ...BASE_POLICY, heartbeatFile: '/hb' };
    const now = 1_000_000_000;
    const mtime = now - 900_000; // 900s ago, threshold is 600s
    const status = checkSweepHeartbeat(policy, {}, { exists: () => true, mtimeMs: () => mtime, now: () => now });
    expect(status).toEqual({ status: 'stale', file: '/hb', ageSeconds: 900, thresholdSeconds: 600 });
  });

  it('uses HEARTBEAT_FILE from env only when policy.heartbeatFile is unset', () => {
    const now = 1_000_000;
    const mtime = now - 1000;
    const status = checkSweepHeartbeat(
      BASE_POLICY,
      { HEARTBEAT_FILE: '/env/hb' },
      { exists: () => true, mtimeMs: () => mtime, now: () => now },
    );
    expect(status.status).toBe('fresh');
    expect((status as { file: string }).file).toBe('/env/hb');
  });

  describe('with real files via defaultSweepHeartbeatDeps', () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('detects a stale heartbeat from a backdated mtime', () => {
      dir = mkdtempSync(join(tmpdir(), 'sweep-heartbeat-'));
      const file = join(dir, 'auto-merge-sweep.heartbeat');
      writeFileSync(file, new Date().toISOString());
      const past = new Date(Date.now() - 1_000_000);
      utimesSync(file, past, past);

      const policy = { ...BASE_POLICY, heartbeatFile: file };
      const status = checkSweepHeartbeat(policy, {}, defaultSweepHeartbeatDeps());
      expect(status.status).toBe('stale');
    });
  });
});

describe('sweepHeartbeatCheck', () => {
  it('returns null for unconfigured', () => {
    expect(sweepHeartbeatCheck({ status: 'unconfigured' })).toBeNull();
  });

  it('returns ok:false for missing', () => {
    const check = sweepHeartbeatCheck({ status: 'missing', file: '/hb' });
    expect(check?.ok).toBe(false);
    expect(check?.name).toBe('auto-merge sweep heartbeat');
  });

  it('returns ok:false for stale', () => {
    const check = sweepHeartbeatCheck({ status: 'stale', file: '/hb', ageSeconds: 900, thresholdSeconds: 600 });
    expect(check?.ok).toBe(false);
    expect(check?.fix).toBeDefined();
  });

  it('returns ok:true for fresh', () => {
    const check = sweepHeartbeatCheck({ status: 'fresh', file: '/hb', ageSeconds: 100, thresholdSeconds: 600 });
    expect(check?.ok).toBe(true);
  });
});

describe('formatSweepHeartbeatStatusLine', () => {
  it('returns a distinguishable, non-empty string for each branch', () => {
    const lines = [
      formatSweepHeartbeatStatusLine({ status: 'unconfigured' }),
      formatSweepHeartbeatStatusLine({ status: 'missing', file: '/hb' }),
      formatSweepHeartbeatStatusLine({ status: 'stale', file: '/hb', ageSeconds: 900, thresholdSeconds: 600 }),
      formatSweepHeartbeatStatusLine({ status: 'fresh', file: '/hb', ageSeconds: 100, thresholdSeconds: 600 }),
    ];
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
  });
});
