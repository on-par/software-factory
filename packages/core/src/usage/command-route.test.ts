import { describe, expect, it } from 'vitest';

import { resolveRunUsageHarness } from './index.js';

describe('resolveRunUsageHarness command route (#2872)', () => {
  it('keeps Claude gating for the command route', () => {
    expect(
      resolveRunUsageHarness({
        buildRoute: 'command',
        buildRouteSource: 'build-pin',
        planHarnesses: ['codex-cli'],
        codexDisabled: false,
        localOnly: false,
      }),
    ).toBeUndefined();
  });
});
