import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFactoryPaths } from './index.js';

describe('getFactoryPaths', () => {
  it('stages triage output alongside the live queue path', () => {
    const repoRoot = '/tmp/some-repo';
    const paths = getFactoryPaths(repoRoot);
    expect(paths.queue).toBe(resolve(repoRoot, '.factory', 'queue'));
    expect(paths.queueProposed).toBe(resolve(repoRoot, '.factory', 'queue.proposed'));
  });
});
