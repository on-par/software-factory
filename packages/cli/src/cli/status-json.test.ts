import { describe, expect, it } from 'vitest';
import { buildStatusJson } from './status-json.js';

const now = Date.parse('2026-01-01T00:10:00.000Z');

describe('buildStatusJson', () => {
  it('builds the full shape', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: 'alpha',
      stop: true,
      breakers: [
        { provider: 'openai', reason: 'usage_cap', openedAt: '2026-01-01T00:00:00.000Z', remainingMs: 90_500 },
      ],
      active: [{ lane: 'app', issue: 7, phase: 'build', lastActivityAt: new Date(now - 125_000).toISOString() }],
      now,
    });
    expect(out).toEqual({
      schemaVersion: 1,
      repo: 'o/r',
      product: 'alpha',
      stop: true,
      breaker: {
        open: true,
        providers: [
          { provider: 'openai', reason: 'usage_cap', openedAt: '2026-01-01T00:00:00.000Z', remainingSec: 91 },
        ],
      },
      active: [{ lane: 'app', issue: 7, phase: 'build', ageSec: 125 }],
    });
    expect(Object.keys(out)).toEqual(['schemaVersion', 'repo', 'product', 'stop', 'breaker', 'active']);
  });

  it('reports closed breaker, no claims and null product', () => {
    const out = buildStatusJson({ repo: 'o/r', product: null, stop: false, breakers: [], active: [], now });
    expect(out.breaker).toEqual({ open: false, providers: [] });
    expect(out.active).toEqual([]);
    expect(out.product).toBeNull();
    expect(out.stop).toBe(false);
  });

  it('clamps future and unparsable activity times to 0', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: null,
      stop: false,
      breakers: [],
      active: [
        { lane: 'a', issue: 1, phase: 'build', lastActivityAt: new Date(now + 60_000).toISOString() },
        { lane: 'b', issue: 2, phase: 'build', lastActivityAt: 'garbage' },
      ],
      now,
    });
    expect(out.active.map((r) => r.ageSec)).toEqual([0, 0]);
  });
});
