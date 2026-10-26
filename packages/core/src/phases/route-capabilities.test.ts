import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BuildRoutePin } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { writeSpec } from '../spec/index.js';
import {
  codexUnavailable,
  recordRouteDegradation,
  resolveRoute,
  type RouteCapabilities,
} from './route-capabilities.js';

const caps = (over: Partial<RouteCapabilities> = {}): RouteCapabilities => ({
  codexDisabled: false,
  codexBreakerOpen: false,
  localOnly: false,
  ...over,
});

describe('resolveRoute', () => {
  it('falls back codex→claude when codex is disabled or its breaker is open and keeps every other route', () => {
    expect(resolveRoute('codex', caps({ codexDisabled: true }))).toEqual({ route: 'claude', reason: 'codex-disabled' });
    expect(resolveRoute('codex', caps({ codexBreakerOpen: true }))).toEqual({
      route: 'claude',
      reason: 'breaker-open',
    });
    expect(resolveRoute('codex', caps())).toEqual({ route: 'codex' });
    for (const route of ['claude', 'opencode', 'command'] as const) {
      expect(resolveRoute(route, caps({ codexDisabled: true, codexBreakerOpen: true }))).toEqual({ route });
    }
  });

  it('codexUnavailable treats missing capabilities as available', () => {
    expect(codexUnavailable(undefined)).toBe(false);
    expect(codexUnavailable(caps({ codexBreakerOpen: true }))).toBe(true);
  });
});

describe('recordRouteDegradation', () => {
  const tempDirs = createTempDirs();
  afterEach(() => tempDirs.cleanup());
  const spec = async (route: BuildRoutePin) => {
    const dir = await tempDirs.make('route-cap-');
    const specPath = join(dir, 's.md');
    await writeSpec(specPath, { body: '# Spec\n', data: { route } });
    return specPath;
  };

  it('writes the route and logs route-degraded once', async () => {
    const specPath = await spec('codex');
    const logs: Array<[EventKind, string]> = [];
    const changed = await recordRouteDegradation({
      specPath,
      specRoute: 'codex',
      actualRoute: 'claude',
      reason: 'breaker-open',
      log: (t, m) => logs.push([t, m]),
    });
    expect(changed).toBe(true);
    expect(await readFile(specPath, 'utf8')).toContain('route: claude');
    expect(logs).toEqual([['route-degraded', expect.stringContaining('codex → claude (breaker-open)')]]);
  });

  it('does nothing when the routes are equal', async () => {
    const specPath = await spec('claude');
    const logs: string[] = [];
    const changed = await recordRouteDegradation({
      specPath,
      specRoute: 'claude',
      actualRoute: 'claude',
      reason: 'build-failover',
      log: (_t, m) => logs.push(m),
    });
    expect(changed).toBe(false);
    expect(logs).toEqual([]);
  });
});
