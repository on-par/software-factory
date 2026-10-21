// packages/cli/src/cli/land-runtime.test.ts — the land runtime accessor (#2784) and swapping it for a test (#3381)

import { describe, expect, it, vi } from 'vitest';

describe('landRuntime', () => {
  it('throws before index.ts has registered the accessor', async () => {
    vi.resetModules();
    const { landRuntime } = await import('./land-runtime.js');
    expect(() => landRuntime()).toThrow('land runtime not registered');
  });

  it('setLandRuntime returns the previous accessor so it can be restored', async () => {
    vi.resetModules();
    const index = await import('./index.js');
    const { landRuntime, setLandRuntime } = await import('./land-runtime.js');
    expect(landRuntime().errorDetail).toBe(index.errorDetail);
    const swapped = { errorDetail: () => 'swapped' } as never;
    const previous = setLandRuntime(() => swapped);
    expect(landRuntime()).toBe(swapped);
    setLandRuntime(previous!);
    expect(landRuntime().errorDetail).toBe(index.errorDetail);
  });
});
