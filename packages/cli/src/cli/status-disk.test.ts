import { describe, expect, it } from 'vitest';

import { defaultFactoryConfig } from '@on-par/factory-config';

import { probeDisk } from './status-disk.js';
import { statusDiskJson } from './status-json.js';

const GIB = 1024 ** 3;
const cfg = defaultFactoryConfig as never;

describe('probeDisk', () => {
  it('reports low using the emptiest of the worktree root and state root', () => {
    const d = probeDisk('/repo', 'o/r', '/state', cfg, (p) => ({
      path: p,
      freeBytes: (p === '/state' ? 1 : 50) * GIB,
    }));
    expect(d?.decision.kind).toBe('low');
    expect(statusDiskJson(d)).toEqual({ freeGb: 1, thresholdGb: 10, low: true });
  });
  it('reports not low with enough space', () => {
    const d = probeDisk('/repo', 'o/r', '/state', cfg, (p) => ({ path: p, freeBytes: 50 * GIB }));
    expect(statusDiskJson(d)).toEqual({ freeGb: 50, thresholdGb: 10, low: false });
  });
  it('is null when every probe fails', () => {
    const d = probeDisk('/repo', 'o/r', '/state', cfg, () => {
      throw new Error('x');
    });
    expect(d).toBeNull();
    expect(statusDiskJson(d)).toBeNull();
  });
});
