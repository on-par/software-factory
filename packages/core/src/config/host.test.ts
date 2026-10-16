import { describe, expect, it } from 'vitest';

import { factoryRuntimeConfigIssues, loadFactoryConfig, resolveHostMaxBuilds } from './index.js';

describe('host.maxBuilds (#3043)', () => {
  it('defaults to 2 and resolves from the shipped config', () => {
    expect(factoryRuntimeConfigIssues({})).toEqual([]);
    expect(loadFactoryConfig().host.maxBuilds).toBe(2);
    expect(resolveHostMaxBuilds(loadFactoryConfig())).toBe(2);
  });

  it('resolves a configured value', () => {
    expect(resolveHostMaxBuilds({ ...loadFactoryConfig(), host: { maxBuilds: 5 } })).toBe(5);
  });

  it.each([0, -1, 1.5])('rejects maxBuilds %s', (maxBuilds) => {
    expect(factoryRuntimeConfigIssues({ host: { maxBuilds } })).not.toEqual([]);
  });
});
