// packages/cli/src/cli/ship-runtime.test.ts — the ship runtime accessor throws until index.ts registers it (#2788)

import { describe, expect, it, vi } from 'vitest';

describe('shipRuntime', () => {
  it('throws before index.ts has registered the accessor', async () => {
    vi.resetModules();
    const { shipRuntime } = await import('./ship-runtime.js');
    expect(() => shipRuntime()).toThrow('ship runtime not registered');
  });

  it('exposes index.ts classes once registered', async () => {
    vi.resetModules();
    const index = await import('./index.js');
    const { shipRuntime } = await import('./ship-runtime.js');
    expect(shipRuntime().LaneParkError).toBe(index.LaneParkError);
    expect(shipRuntime().errorDetail).toBe(index.errorDetail);
  });
});
