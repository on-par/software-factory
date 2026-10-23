import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readStopMarker } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { describe, expect, it } from 'vitest';

import { buildStatusJson } from './status-json.js';
import { statusJsonSchema } from './json-contract.js';

const temp = createTempDirs();
const now = Date.parse('2026-01-01T00:10:00.000Z');

describe('buildStatusJson', () => {
  it('builds the full shape', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: 'alpha',
      stop: true,
      stopInfo: { source: 'manual', setAt: '2026-01-01T00:00:00.000Z' },
      breakers: [
        { provider: 'openai', reason: 'usage_cap', openedAt: '2026-01-01T00:00:00.000Z', remainingMs: 90_500 },
      ],
      active: [{ lane: 'app', issue: 7, phase: 'build', lastActivityAt: new Date(now - 125_000).toISOString() }],
      disk: null,
      update: null,
      now,
    });
    expect(out).toEqual({
      schemaVersion: 1,
      repo: 'o/r',
      product: 'alpha',
      stop: true,
      stopInfo: { source: 'manual', setAt: '2026-01-01T00:00:00.000Z' },
      breaker: {
        open: true,
        providers: [
          { provider: 'openai', reason: 'usage_cap', openedAt: '2026-01-01T00:00:00.000Z', remainingSec: 91 },
        ],
      },
      active: [{ lane: 'app', issue: 7, phase: 'build', ageSec: 125 }],
      disk: null,
      update: null,
    });
    expect(Object.keys(out)).toEqual([
      'schemaVersion',
      'repo',
      'product',
      'stop',
      'stopInfo',
      'breaker',
      'active',
      'disk',
      'update',
    ]);
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('reports closed breaker, no claims and null product', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: null,
      stop: false,
      stopInfo: null,
      breakers: [],
      active: [],
      disk: null,
      update: null,
      now,
    });
    expect(out.breaker).toEqual({ open: false, providers: [] });
    expect(out.active).toEqual([]);
    expect(out.product).toBeNull();
    expect(out.stop).toBe(false);
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('maps a GitHub-label-queue row (lane, issue, phase, lastActivityAt) to an active row with ageSec (#3344)', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: null,
      stop: false,
      stopInfo: null,
      breakers: [],
      active: [{ lane: 'bugfix', issue: 3316, phase: 'check', lastActivityAt: new Date(now - 90_000).toISOString() }],
      disk: null,
      update: null,
      now,
    });
    expect(out.active).toEqual([{ lane: 'bugfix', issue: 3316, phase: 'check', ageSec: 90 }]);
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('clamps future and unparsable activity times to 0', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: null,
      stop: false,
      stopInfo: null,
      breakers: [],
      active: [
        { lane: 'a', issue: 1, phase: 'build', lastActivityAt: new Date(now + 60_000).toISOString() },
        { lane: 'b', issue: 2, phase: 'build', lastActivityAt: 'garbage' },
      ],
      disk: null,
      update: null,
      now,
    });
    expect(out.active.map((r) => r.ageSec)).toEqual([0, 0]);
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('copies a populated update object through', () => {
    const update = {
      mode: 'stable' as const,
      channel: 'latest' as const,
      installKind: 'npm-global' as const,
      current: '0.9.0',
      available: '0.9.1',
      lastCheckAt: null,
      lastResult: null,
      draining: null,
    };
    expect(
      buildStatusJson({
        repo: 'o/r',
        product: null,
        stop: false,
        stopInfo: null,
        breakers: [],
        active: [],
        disk: null,
        update,
        now,
      }).update,
    ).toEqual(update);
  });

  it('reports stopInfo for a legacy empty STOP as unknown with the file mtime', async () => {
    const dir = temp.makeSync('status-stop-');
    try {
      const file = join(dir, 'STOP');
      writeFileSync(file, '');
      const marker = readStopMarker(file);
      const out = buildStatusJson({
        repo: 'o/r',
        product: null,
        stop: true,
        stopInfo: marker ? { source: marker.source, setAt: marker.at ?? null } : null,
        breakers: [],
        active: [],
        disk: null,
        update: null,
        now,
      });
      expect(out.stopInfo?.source).toBe('unknown');
      expect(Number.isFinite(Date.parse(out.stopInfo?.setAt ?? ''))).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });
});
