import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStatusUpdateJson,
  formatUpdateStartupLine,
  formatUpdateStatusLine,
  initialUpdateState,
  readUpdateState,
  recordUpdateCheck,
  updateStatePath,
  writeUpdateState,
  type UpdateState,
} from './update-state.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'update-state-'));
  file = updateStatePath(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  schemaVersion: 1,
  mode: 'stable',
  channel: 'latest',
  installKind: 'npm-global',
  current: '0.9.0',
  available: null,
  lastCheckAt: null,
  lastResult: null,
  draining: null,
  ...over,
});
const put = (value: unknown): void => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

describe('readUpdateState', () => {
  it('returns null for a missing file, bad JSON, arrays and null', () => {
    expect(readUpdateState(file)).toBeNull();
    put('not json');
    expect(readUpdateState(file)).toBeNull();
    put([]);
    expect(readUpdateState(file)).toBeNull();
    put('null');
    expect(readUpdateState(file)).toBeNull();
  });

  it('returns null for an invalid mode or a missing current', () => {
    put({ ...state(), mode: 'weekly' });
    expect(readUpdateState(file)).toBeNull();
    put({ ...state(), current: undefined });
    expect(readUpdateState(file)).toBeNull();
    put({ ...state(), current: 9 });
    expect(readUpdateState(file)).toBeNull();
  });

  it('drops an unknown outcome but keeps the rest', () => {
    put({ ...state({ available: '0.9.1' }), lastResult: { at: 'a', version: '0.9.1', outcome: 'exploded' } });
    expect(readUpdateState(file)).toMatchObject({ available: '0.9.1', lastResult: null });
  });

  it('keeps a valid lastResult with its error', () => {
    put({ ...state(), lastResult: { at: 'a', version: '0.9.1', outcome: 'failed', error: 'boom' } });
    expect(readUpdateState(file)?.lastResult).toEqual({ at: 'a', version: '0.9.1', outcome: 'failed', error: 'boom' });
  });

  it('coerces a bad installKind, channel and malformed draining', () => {
    put({ ...state(), installKind: 'brew', channel: 'beta', draining: { since: 'x' } });
    expect(readUpdateState(file)).toMatchObject({ installKind: 'unknown', channel: null, draining: null });
  });
});

describe('writeUpdateState', () => {
  it('round-trips and leaves no tmp file', () => {
    const s = state({ available: '0.9.1', draining: { since: 's', target: '0.9.1' } });
    writeUpdateState(file, s);
    expect(readUpdateState(file)).toEqual(s);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readdirSync(dir)).toEqual(['update-state.json']);
  });
});

describe('initialUpdateState', () => {
  const cfg = (mode: 'manual' | 'stable'): Parameters<typeof initialUpdateState>[0] => ({
    autoUpdate: {
      mode,
      requestedMode: mode,
      channel: mode === 'manual' ? null : 'latest',
      checkIntervalMinutes: 60,
      drainTimeoutMinutes: 10,
    },
    install: { kind: 'npm-global', prefix: '/usr/local', version: '0.9.0' },
  });

  it('keeps previous lastCheckAt/lastResult/available and resets draining', () => {
    const previous = state({
      available: '0.9.1',
      lastCheckAt: 't',
      lastResult: { at: 'a', version: '0.8.9', outcome: 'updated' },
      draining: { since: 's', target: '0.9.1' },
    });
    expect(initialUpdateState(cfg('stable'), previous)).toEqual({ ...previous, draining: null });
  });

  it('nulls available in manual mode and when equal to current', () => {
    expect(initialUpdateState(cfg('manual'), state({ available: '0.9.1' })).available).toBeNull();
    expect(initialUpdateState(cfg('stable'), state({ available: '0.9.0' })).available).toBeNull();
    expect(initialUpdateState(cfg('stable'), null)).toMatchObject({ lastCheckAt: null, lastResult: null });
  });
});

describe('buildStatusUpdateJson', () => {
  it('buildStatusUpdateJson nulls available in manual mode', () => {
    const out = buildStatusUpdateJson(state({ mode: 'manual', channel: null, available: '0.9.1' }));
    expect(out).toMatchObject({ mode: 'manual', available: null });
  });
  it('maps null to null and drops schemaVersion', () => {
    expect(buildStatusUpdateJson(null)).toBeNull();
    expect(buildStatusUpdateJson(state({ available: '0.9.1' }))).not.toHaveProperty('schemaVersion');
    expect(buildStatusUpdateJson(state({ available: '0.9.1' }))?.available).toBe('0.9.1');
  });
});

describe('formatUpdateStatusLine', () => {
  const line = (over: Partial<UpdateState>) => formatUpdateStatusLine(buildStatusUpdateJson(state(over)));

  it('reports available, up to date and manual', () => {
    expect(line({ available: '0.9.1' })).toBe('factory 0.9.0 (stable, npm) — 0.9.1 available');
    expect(line({ available: '0.9.0' })).toBe('factory 0.9.0 (stable, npm) — up to date');
    expect(line({})).toBe('factory 0.9.0 (stable, npm) — up to date');
    expect(line({ mode: 'manual', channel: null, available: '0.9.1' })).toBe(
      'factory 0.9.0 (manual, npm) — automatic updates off',
    );
  });

  it('appends the last result, error and draining', () => {
    expect(line({ available: '0.9.1', lastResult: { at: 'a', version: '0.9.1', outcome: 'rolled-back' } })).toBe(
      'factory 0.9.0 (stable, npm) — 0.9.1 available; last update to 0.9.1 rolled back',
    );
    expect(line({ lastResult: { at: 'a', version: '0.9.1', outcome: 'failed', error: 'EACCES' } })).toContain(
      'last update to 0.9.1 failed (EACCES)',
    );
    expect(line({ lastResult: { at: 'a', version: '0.9.1', outcome: 'updated' } })).toContain('0.9.1 updated');
    expect(line({ lastResult: { at: 'a', version: '0.9.1', outcome: 'skipped' } })).toContain('0.9.1 skipped');
    expect(line({ draining: { since: 's', target: '0.9.1' } })).toContain('; draining for 0.9.1 since s');
  });

  it('labels each install kind and the missing state', () => {
    expect(line({ installKind: 'source' })).toContain('(stable, source)');
    expect(line({ installKind: 'unknown' })).toContain('(stable, unknown install)');
    expect(formatUpdateStatusLine(null)).toBe('factory update: no factoryd update state (daemon not started?)');
  });
});

describe('formatUpdateStartupLine', () => {
  it('formatUpdateStartupLine names the mode and running version', () => {
    const out = formatUpdateStartupLine(state());
    expect(out).toContain('mode stable');
    expect(out).toContain('factory 0.9.0');
    expect(formatUpdateStartupLine(state({ mode: 'manual', channel: null }))).toContain('channel none');
  });
});

describe('recordUpdateCheck', () => {
  it('writes lastCheckAt/available and logs exactly one line', () => {
    writeUpdateState(file, state());
    const lines: string[] = [];
    const next = recordUpdateCheck(file, { at: 't1', available: '0.9.1' }, (l) => lines.push(l));
    expect(next).toMatchObject({ lastCheckAt: 't1', available: '0.9.1' });
    expect(readUpdateState(file)).toMatchObject({ lastCheckAt: 't1', available: '0.9.1' });
    expect(lines).toEqual(['update check: 0.9.1 available on latest (current 0.9.0)']);
    recordUpdateCheck(file, { at: 't2', available: null }, (l) => lines.push(l));
    expect(lines[1]).toBe('update check: up to date on latest (current 0.9.0)');
  });

  it('returns null and logs nothing without a state file', () => {
    const lines: string[] = [];
    expect(recordUpdateCheck(file, { at: 't', available: null }, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([]);
  });
});
