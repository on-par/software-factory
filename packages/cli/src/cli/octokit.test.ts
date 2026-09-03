import { describe, expect, it } from 'vitest';

import { createFactoryOctokit, MAX_THROTTLE_RETRIES, onRateLimit, onSecondaryRateLimit } from './octokit.js';

describe('onRateLimit', () => {
  it('retries while under the bound', () => {
    expect(onRateLimit(60, { method: 'GET', url: '/x' }, undefined, 0)).toBe(true);
  });

  it('stops retrying once the bound is reached', () => {
    expect(onRateLimit(60, { method: 'GET', url: '/x' }, undefined, MAX_THROTTLE_RETRIES)).toBe(false);
  });
});

describe('onSecondaryRateLimit', () => {
  it('retries while under the bound', () => {
    expect(onSecondaryRateLimit(60, { method: 'GET', url: '/x' }, undefined, 0)).toBe(true);
  });

  it('stops retrying once the bound is reached', () => {
    expect(onSecondaryRateLimit(60, { method: 'GET', url: '/x' }, undefined, MAX_THROTTLE_RETRIES)).toBe(false);
  });
});

describe('createFactoryOctokit', () => {
  it('constructs a client with the expected REST surface, given a token', () => {
    const octokit = createFactoryOctokit('t');
    expect(typeof octokit.rest.pulls.list).toBe('function');
  });

  it('constructs a client with no token', () => {
    const octokit = createFactoryOctokit();
    expect(typeof octokit.rest.pulls.list).toBe('function');
  });
});
