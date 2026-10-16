import { describe, expect, it } from 'vitest';

import { factoryRuntimeConfigIssues, loadFactoryConfig, resolveHostLoadGuard, resolveHostMaxBuilds } from './index.js';

describe('host.maxBuilds (#3043)', () => {
  it('defaults to 2 and resolves from the shipped config', () => {
    expect(factoryRuntimeConfigIssues({})).toEqual([]);
    expect(loadFactoryConfig().host.maxBuilds).toBe(2);
    expect(resolveHostMaxBuilds(loadFactoryConfig())).toBe(2);
  });

  it('resolves a configured value', () => {
    expect(
      resolveHostMaxBuilds({
        ...loadFactoryConfig(),
        host: { maxBuilds: 5, loadGuard: { enabled: true, retrySeconds: 60 } },
      }),
    ).toBe(5);
  });

  it.each([0, -1, 1.5])('rejects maxBuilds %s', (maxBuilds) => {
    expect(factoryRuntimeConfigIssues({ host: { maxBuilds } })).not.toEqual([]);
  });
});

describe('host.loadGuard (#3048)', () => {
  const base = loadFactoryConfig();

  it('resolves the defaults', () => {
    expect(resolveHostLoadGuard(base, {})).toEqual({ enabled: true, maxLoad: undefined, retryMs: 60000 });
  });

  it('honours configured maxLoad and retrySeconds', () => {
    const config = { ...base, host: { ...base.host, loadGuard: { enabled: true, maxLoad: 12, retrySeconds: 5 } } };
    expect(resolveHostLoadGuard(config, {})).toEqual({ enabled: true, maxLoad: 12, retryMs: 5000 });
  });

  it('FACTORY_LOAD_GUARD=0 disables the guard', () => {
    expect(resolveHostLoadGuard(base, { FACTORY_LOAD_GUARD: '0' }).enabled).toBe(false);
  });

  it('FACTORY_LOAD_GUARD=1 overrides enabled: false', () => {
    const config = { ...base, host: { ...base.host, loadGuard: { enabled: false, retrySeconds: 60 } } };
    expect(resolveHostLoadGuard(config, { FACTORY_LOAD_GUARD: '1' }).enabled).toBe(true);
  });

  it('rejects invalid retrySeconds and maxLoad', () => {
    expect(factoryRuntimeConfigIssues({ host: { loadGuard: { retrySeconds: 0 } } })).not.toEqual([]);
    expect(factoryRuntimeConfigIssues({ host: { loadGuard: { maxLoad: -1 } } })).not.toEqual([]);
  });
});
