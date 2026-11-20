import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadFactoryConfig, loadFactoryConfigForRepo } from './index.js';
import { LandConfigSections } from './land-section.js';

const MISSING_CONFIG = '/nonexistent/.factory/config.json';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('land section schema (#4308)', () => {
  it('keeps the section and waitForCi optional with no default', () => {
    expect(LandConfigSections.land.parse(undefined)).toBeUndefined();
    expect(LandConfigSections.land.parse({})).toEqual({});
  });

  it('accepts a boolean waitForCi and rejects other values and unknown keys', () => {
    expect(LandConfigSections.land.parse({ waitForCi: false })).toEqual({ waitForCi: false });
    expect(LandConfigSections.land.parse({ waitForCi: true })).toEqual({ waitForCi: true });
    expect(LandConfigSections.land.safeParse({ waitForCi: 'no' }).success).toBe(false);
    expect(LandConfigSections.land.safeParse({ other: 1 }).success).toBe(false);
  });
});

describe('land.waitForCi in the repo config (#4308)', () => {
  it('keeps an explicit false through the runtime overlay', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ land: { waitForCi: false } }));
    expect(loadFactoryConfigForRepo(MISSING_CONFIG).land).toEqual({ waitForCi: false });
  });

  it('leaves land unset when the config does not mention it', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ merge: { auto: false } }));
    expect(loadFactoryConfigForRepo(MISSING_CONFIG).land).toBeUndefined();
    expect(loadFactoryConfig().land).toBeUndefined();
  });

  it('rejects a non-boolean waitForCi', () => {
    vi.stubEnv('FACTORY_RUN_CONFIG_JSON', JSON.stringify({ land: { waitForCi: 'later' } }));
    expect(() => loadFactoryConfigForRepo(MISSING_CONFIG)).toThrow(/land\.waitForCi/);
  });
});
