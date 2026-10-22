import { defaultUsageCapUsd, defaultWatchdogStopAt } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import { resolveUsageCap, resolveWatchdogPolicy } from './repo.js';

describe('repo config defaults come from defaults.ts', () => {
  it('resolveUsageCap falls back to defaultUsageCapUsd', () => {
    expect(resolveUsageCap(null, {})).toEqual({ cap: defaultUsageCapUsd, source: 'default' });
  });

  it('resolveWatchdogPolicy falls back to defaultWatchdogStopAt', () => {
    const policy = resolveWatchdogPolicy(null, {});
    expect(policy.stopAt).toBe(defaultWatchdogStopAt);
    expect(policy.sources.stopAt).toBe('default');
  });
});
