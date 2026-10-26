// src/phases/plan-route-resolve.test.ts — resolveRunnableBuildRoute, split out of plan.test.ts

import { describe, expect, it } from 'vitest';

import { resolveRunnableBuildRoute } from './plan.js';

describe('resolveRunnableBuildRoute', () => {
  it('does not restrict when the runnable set is unknown', () => {
    expect(resolveRunnableBuildRoute('claude', [])).toEqual({ route: 'claude', rerouted: false });
  });
  it('reroutes to the first runnable route', () => {
    expect(resolveRunnableBuildRoute('claude', ['codex', 'opencode'])).toEqual({ route: 'codex', rerouted: true });
  });
  it('keeps a runnable route', () => {
    expect(resolveRunnableBuildRoute('opencode', ['claude', 'opencode'])).toEqual({
      route: 'opencode',
      rerouted: false,
    });
  });
});
