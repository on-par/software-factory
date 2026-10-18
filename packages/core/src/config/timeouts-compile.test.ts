import { describe, expect, it } from 'vitest';

import { loadFactoryConfig, resolveTimeouts } from './index.js';

describe('resolveTimeouts compile (#3185)', () => {
  it('resolveTimeouts compile: FACTORY_COMPILE_TIMEOUT beats compile_seconds beats 120', () => {
    const config = loadFactoryConfig();
    const withCompile = { ...config, timeouts: { ...config.timeouts, compile_seconds: 400 } };
    expect(resolveTimeouts(withCompile, { FACTORY_COMPILE_TIMEOUT: '600' }).compile).toBe(600);
    expect(resolveTimeouts(withCompile, {}).compile).toBe(400);
    expect(resolveTimeouts(config, {}).compile).toBe(120);
  });

  it('ignores an invalid FACTORY_COMPILE_TIMEOUT and falls back to config', () => {
    const config = loadFactoryConfig();
    const withCompile = { ...config, timeouts: { ...config.timeouts, compile_seconds: 400 } };
    expect(resolveTimeouts(withCompile, { FACTORY_COMPILE_TIMEOUT: 'abc' }).compile).toBe(400);
    expect(resolveTimeouts(withCompile, { FACTORY_COMPILE_TIMEOUT: '0' }).compile).toBe(400);
  });
});
