import { describe, expect, it } from 'vitest';

import { hermeticGitEnv, laneEnv } from './index.js';

describe('hermeticGitEnv (#3272)', () => {
  it('points global git config at /dev/null and skips system config when enabled', () => {
    expect(hermeticGitEnv(true)).toEqual({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  });

  it('adds nothing when disabled', () => {
    expect(hermeticGitEnv(false)).toEqual({});
  });

  it('laneEnv adds no GIT_CONFIG_GLOBAL or GIT_CONFIG_NOSYSTEM (BUILD/rework env stays host git)', () => {
    const env = laneEnv(3142, {}, undefined, '/tmp/wt', 'run-1');
    expect(env).not.toHaveProperty('GIT_CONFIG_GLOBAL');
    expect(env).not.toHaveProperty('GIT_CONFIG_NOSYSTEM');
  });
});
