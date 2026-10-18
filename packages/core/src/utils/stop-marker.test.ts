import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { formatStopMarker, readStopMarker } from './stop-marker.js';

describe('stop-marker', () => {
  const temp = createTempDirs();
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = temp.makeSync('stop-marker-');
    file = join(dir, 'STOP');
  });
  afterEach(() => temp.cleanup());

  it.each(['manual', 'usage-watchdog', 'self-update'] as const)('round-trips %s', (source) => {
    const at = new Date('2026-02-03T04:05:06.000Z');
    writeFileSync(file, formatStopMarker(source, at));
    expect(readStopMarker(file)).toEqual({ source, at: at.toISOString() });
  });

  it('round-trips detail', () => {
    writeFileSync(file, formatStopMarker('manual', new Date(0), 'why'));
    expect(readStopMarker(file)?.detail).toBe('why');
  });

  it('returns null when absent', () => {
    expect(readStopMarker(file)).toBeNull();
  });

  it('reports an empty file as unknown with the mtime', () => {
    writeFileSync(file, '');
    expect(readStopMarker(file, { statMtimeMs: () => 1000 })).toEqual({
      source: 'unknown',
      at: new Date(1000).toISOString(),
    });
  });

  it('reports garbage and unknown sources as unknown', () => {
    writeFileSync(file, 'not json');
    expect(readStopMarker(file)?.source).toBe('unknown');
    writeFileSync(file, '{"source":"alien","at":"2026-01-01T00:00:00.000Z"}');
    expect(readStopMarker(file)?.source).toBe('unknown');
  });

  it('falls back to the mtime for an invalid at', () => {
    writeFileSync(file, '{"source":"manual","at":"nope"}');
    expect(readStopMarker(file, { statMtimeMs: () => 5000 })).toEqual({
      source: 'manual',
      at: new Date(5000).toISOString(),
    });
  });

  it('uses epoch when stat fails with a non-ENOENT error', () => {
    const r = readStopMarker(file, {
      readFile: () => '',
      statMtimeMs: () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' });
      },
    });
    expect(r).toEqual({ source: 'unknown', at: new Date(0).toISOString() });
  });

  it('returns null when stat hits ENOENT after a read', () => {
    const r = readStopMarker(file, {
      readFile: () => '',
      statMtimeMs: () => {
        throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    });
    expect(r).toBeNull();
  });
});
