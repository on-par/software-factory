import { describe, expect, it } from 'vitest';

import { harnessHasUsageSignal, resolveRunUsageHarness } from './index.js';

describe('harnessHasUsageSignal', () => {
  it.each([
    [undefined, true],
    ['claude-cli', true],
    ['codex-cli', false],
    ['opencode', false],
    ['', false],
    ['my-agent', false],
  ])('%j -> %s', (harness, expected) => {
    expect(harnessHasUsageSignal(harness)).toBe(expected);
  });
});

describe('resolveRunUsageHarness', () => {
  const base = {
    buildRoute: 'opencode' as const,
    buildRouteSource: 'repo' as const,
    planHarnesses: ['opencode'] as ReadonlyArray<string | undefined>,
    codexDisabled: false,
    localOnly: false,
  };
  it.each([
    ['opencode route, non-Claude plan pin', {}, 'opencode'],
    ['codex route, non-Claude plan pin', { buildRoute: 'codex' as const }, 'codex-cli'],
    ['repo codex route with codexDisabled', { buildRoute: 'codex' as const, codexDisabled: true }, 'codex-cli'],
    ['claude route', { buildRoute: 'claude' as const }, undefined],
    ['undefined route', { buildRoute: undefined, buildRouteSource: 'plan' as const }, undefined],
    ['no plan pins', { planHarnesses: [] }, undefined],
    ['claude-cli plan pin', { planHarnesses: ['claude-cli'] }, undefined],
    ['claude-cli planFallback', { planHarnesses: ['opencode', 'claude-cli'] }, undefined],
    ['unknown plan model', { planHarnesses: [undefined] }, undefined],
    ['localOnly', { localOnly: true }, undefined],
    [
      'build-pin codex route with codexDisabled',
      { buildRoute: 'codex' as const, buildRouteSource: 'build-pin' as const, codexDisabled: true },
      undefined,
    ],
  ])('%s', (_name, override, expected) => {
    expect(resolveRunUsageHarness({ ...base, ...override })).toBe(expected);
  });
});
