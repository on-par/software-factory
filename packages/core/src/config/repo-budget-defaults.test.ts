import { defaultBudget } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';
import { resolveUsageCap, resolveWatchdogPolicy, type RepoFactoryConfig } from './repo.js';

describe('repo budget defaults', () => {
  it('resolveUsageCap falls back to defaultBudget.usageCapUsd (227) with no repo cap or env', () => {
    expect(defaultBudget.usageCapUsd).toBe(227);
    expect(resolveUsageCap(null, {})).toEqual({ cap: defaultBudget.usageCapUsd, source: 'default' });
    const noBudget: RepoFactoryConfig = { version: 2 };
    expect(resolveUsageCap(noBudget, {})).toEqual({ cap: 227, source: 'default' });
  });

  it('resolveWatchdogPolicy falls back to defaultBudget.watchdogStopAt (0.75) with no repo threshold or env', () => {
    const policy = resolveWatchdogPolicy(null, {});
    expect(policy.stopAt).toBe(defaultBudget.watchdogStopAt);
    expect(policy.stopAt).toBe(0.75);
    expect(policy.sources.stopAt).toBe('default');
  });
});
