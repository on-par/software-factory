import { defaultFactoryConfig } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';

import { DEFAULT_USAGE_POLL_MS } from '../usage/constants.js';
import { FactoryConfigSchema, factoryRuntimeConfigIssues, resolveDiskGuard } from './index.js';

const config = (minFreeGb?: number) =>
  FactoryConfigSchema.parse(
    minFreeGb === undefined ? defaultFactoryConfig : { ...defaultFactoryConfig, disk: { minFreeGb } },
  );

describe('resolveDiskGuard (#2284)', () => {
  it('defaults to 10 GB and enabled', () => {
    expect(resolveDiskGuard(config(), {})).toMatchObject({ enabled: true, minFreeGb: 10 });
  });

  it('uses the config value', () => {
    expect(resolveDiskGuard(config(25), {}).minFreeGb).toBe(25);
  });

  it('lets FACTORY_MIN_FREE_GB beat config, including fractions', () => {
    expect(resolveDiskGuard(config(25), { FACTORY_MIN_FREE_GB: '2.5' }).minFreeGb).toBe(2.5);
  });

  it.each(['abc', '-1', '', '   ', 'NaN'])('ignores malformed env %j', (value) => {
    expect(resolveDiskGuard(config(25), { FACTORY_MIN_FREE_GB: value }).minFreeGb).toBe(25);
  });

  it('disables on 0 from env or config', () => {
    expect(resolveDiskGuard(config(25), { FACTORY_MIN_FREE_GB: '0' }).enabled).toBe(false);
    expect(resolveDiskGuard(config(0), {}).enabled).toBe(false);
  });

  it('retries on the usage poll cadence', () => {
    expect(resolveDiskGuard(config(), {}).retryMs).toBe(DEFAULT_USAGE_POLL_MS);
  });

  it('rejects a negative disk.minFreeGb', () => {
    expect(factoryRuntimeConfigIssues({ disk: { minFreeGb: -1 } })).not.toEqual([]);
  });
});
