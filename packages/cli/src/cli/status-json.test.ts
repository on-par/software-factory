import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeParentCoverage, readStopMarker } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { describe, expect, it } from 'vitest';

import { buildStatusJson, statusProviderInputs } from './status-json.js';
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
      update: null,
      openFactoryDrafts: { count: 2, oldestHours: 5 },
      disk: null,
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
      update: null,
      openFactoryDrafts: { count: 2, oldestHours: 5 },
      decomposedParents: null,
      disk: null,
      providers: [],
      activeAlerts: [],
    });
    expect(Object.keys(out)).toEqual([
      'schemaVersion',
      'repo',
      'product',
      'stop',
      'stopInfo',
      'breaker',
      'active',
      'update',
      'openFactoryDrafts',
      'decomposedParents',
      'disk',
      'providers',
      'activeAlerts',
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
      update: null,
      openFactoryDrafts: null,
      disk: null,
      now,
    });
    expect(out.breaker).toEqual({ open: false, providers: [] });
    expect(out.active).toEqual([]);
    expect(out.product).toBeNull();
    expect(out.stop).toBe(false);
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('maps decomposedParents rows and defaults to null (#3108)', () => {
    const base = {
      repo: 'o/r',
      product: null,
      stop: false,
      stopInfo: null,
      breakers: [],
      active: [],
      update: null,
      openFactoryDrafts: null,
      disk: null,
      now,
    };
    expect(buildStatusJson(base).decomposedParents).toBeNull();
    const c = computeParentCoverage({ number: 10, body: '## Acceptance criteria\n- [ ] one\n- [ ] two\n' }, [
      { number: 11, body: 'Covers parent criteria: P1', merged: true },
    ]);
    const out = buildStatusJson({ ...base, decomposedParents: [c] });
    expect(out.decomposedParents).toEqual([
      { issue: 10, covered: 1, total: 2, fullyCovered: false, uncovered: [{ id: 'P2', text: 'two' }] },
    ]);
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
      update: null,
      openFactoryDrafts: null,
      disk: null,
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
      update: null,
      openFactoryDrafts: null,
      disk: null,
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
        update,
        openFactoryDrafts: null,
        disk: null,
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
        update: null,
        openFactoryDrafts: null,
        disk: null,
        now,
      });
      expect(out.stopInfo?.source).toBe('unknown');
      expect(Number.isFinite(Date.parse(out.stopInfo?.setAt ?? ''))).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });

  it('reports an untimed auth entry as remainingSec 0 with until', () => {
    const out = buildStatusJson({
      repo: 'o/r',
      product: null,
      stop: false,
      stopInfo: null,
      breakers: [
        {
          provider: 'anthropic',
          reason: 'local_auth',
          openedAt: '2026-01-01T00:00:00.000Z',
          remainingMs: Number.POSITIVE_INFINITY,
          until: 'credentials-change',
        },
      ],
      active: [],
      update: null,
      openFactoryDrafts: null,
      disk: null,
      now,
    });
    expect(out.breaker.providers[0]).toMatchObject({ remainingSec: 0, until: 'credentials-change' });
    expect(statusJsonSchema.safeParse(out).success).toBe(true);
  });
});

describe('provider alerts (#3236)', () => {
  const base = {
    repo: 'o/r',
    product: null,
    stop: false,
    stopInfo: null,
    active: [],
    update: null,
    openFactoryDrafts: null,
    disk: null,
    now: Date.parse('2026-10-23T11:00:00.000Z'),
  };
  const openedAt = '2026-10-23T10:00:00.000Z';
  const providers = [
    { id: 'anthropic', plan: 'subscription' as const },
    { id: 'openai', plan: 'api' as const },
  ];
  const stages = [{ stage: 'plan' as const, providers: ['anthropic', 'openai'] }];
  const auth = {
    provider: 'anthropic',
    reason: 'local_auth',
    openedAt,
    remainingMs: Number.POSITIVE_INFINITY,
    until: 'credentials-change' as const,
  };

  it('status --json lists providers and derives activeAlerts from breaker state', () => {
    // events.ndjson is empty: the builder never reads it, so alerts come from breaker state alone
    writeFileSync(join(temp.makeSync('status-alerts-'), 'events.ndjson'), '');
    const out = buildStatusJson({ ...base, breakers: [auth], providers, stages });
    expect(out.providers).toEqual([
      { id: 'anthropic', plan: 'subscription', breaker: 'open', openedReason: 'local_auth', openedAt },
      { id: 'openai', plan: 'api', breaker: 'closed', openedReason: null, openedAt: null },
    ]);
    expect('resetAt' in out.providers[0]).toBe(false);
    expect(out.activeAlerts).toEqual([
      expect.objectContaining({ kind: 'provider_auth_rejected', provider: 'anthropic', since: openedAt }),
    ]);
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('raises all_providers_down for a stage whose providers are all untimed-open', () => {
    const out = buildStatusJson({
      ...base,
      breakers: [auth, { provider: 'openai', reason: 'timeout', openedAt, remainingMs: 60_000 }],
      providers,
      stages,
    });
    expect(out.activeAlerts.map((a) => a.kind)).toEqual(['provider_auth_rejected', 'all_providers_down']);
    expect(out.activeAlerts[1]).toMatchObject({ stage: 'plan', since: openedAt });
    expect(statusJsonSchema.parse(out)).toEqual(out);
  });

  it('a timed usage_cap breaker sets resetAt and suppresses all_providers_down', () => {
    const out = buildStatusJson({
      ...base,
      breakers: [auth, { provider: 'openai', reason: 'usage_cap', openedAt, remainingMs: 3_600_000 }],
      providers,
      stages,
    });
    expect(out.providers[1].resetAt).toBe('2026-10-23T12:00:00.000Z');
    expect(out.activeAlerts.map((a) => a.kind)).toEqual(['provider_auth_rejected']);
    expect(out.schemaVersion).toBe(1);
  });

  it('keeps an unregistered provider out of providers[] but still alerts, and ignores empty stages', () => {
    const out = buildStatusJson({
      ...base,
      breakers: [auth],
      providers: [],
      stages: [{ stage: 'build', providers: [] }],
    });
    expect(out.providers).toEqual([]);
    expect(out.activeAlerts).toHaveLength(1);
  });

  it('statusProviderInputs lists distinct providers in registry order and dedupes stage providers', () => {
    const defs: Record<string, { provider?: string }> = {
      a1: { provider: 'anthropic' },
      a2: { provider: 'anthropic' },
      o1: { provider: 'openai' },
      none: {},
    };
    const router = {
      registryRef: { list: () => Object.keys(defs), get: (id: string) => defs[id] },
      resolveAll: (task: string) => (task === 'plan' ? ['a1', 'a2', 'o1'] : task === 'build_claude' ? ['a1'] : ['o1']),
    };
    const plan = (p: string) => (p === 'anthropic' ? ('subscription' as const) : ('api' as const));
    expect(statusProviderInputs(router, { failoverEnabled: true, plan })).toEqual({
      providers: [
        { id: 'anthropic', plan: 'subscription' },
        { id: 'openai', plan: 'api' },
      ],
      stages: [
        { stage: 'plan', providers: ['anthropic', 'openai'] },
        { stage: 'build', providers: ['anthropic', 'openai'] },
      ],
    });
    expect(statusProviderInputs(router, { failoverEnabled: false, plan }).stages).toEqual([
      { stage: 'plan', providers: ['anthropic'] },
      { stage: 'build', providers: ['anthropic'] },
    ]);
  });
});
