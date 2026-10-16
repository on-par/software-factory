import { describe, expect, it } from 'vitest';

import {
  factoryRuntimeConfigIssues,
  loadFactoryConfig,
  resolveHostMaxAgentJobs,
  resolveHostMaxBuilds,
} from './index.js';

describe('host.maxBuilds (#3043)', () => {
  it('defaults to 2 and resolves from the shipped config', () => {
    expect(factoryRuntimeConfigIssues({})).toEqual([]);
    expect(loadFactoryConfig().host.maxBuilds).toBe(2);
    expect(resolveHostMaxBuilds(loadFactoryConfig())).toBe(2);
  });

  it('resolves a configured value', () => {
    expect(resolveHostMaxBuilds({ ...loadFactoryConfig(), host: { maxBuilds: 5, maxAgentJobs: 1 } })).toBe(5);
  });

  it.each([0, -1, 1.5])('rejects maxBuilds %s', (maxBuilds) => {
    expect(factoryRuntimeConfigIssues({ host: { maxBuilds } })).not.toEqual([]);
  });
});

describe('host.maxAgentJobs (#3047)', () => {
  it('defaults to 1', () => {
    expect(loadFactoryConfig().host.maxAgentJobs).toBe(1);
    expect(resolveHostMaxAgentJobs(loadFactoryConfig())).toBe(1);
  });

  it('resolves a configured value', () => {
    expect(resolveHostMaxAgentJobs({ ...loadFactoryConfig(), host: { maxBuilds: 2, maxAgentJobs: 3 } })).toBe(3);
  });

  it.each([0, -1, 1.5])('rejects maxAgentJobs %s', (maxAgentJobs) => {
    expect(factoryRuntimeConfigIssues({ host: { maxAgentJobs } })).not.toEqual([]);
  });
});
