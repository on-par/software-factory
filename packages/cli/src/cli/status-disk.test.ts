// packages/cli/src/cli/status-disk.test.ts — disk guard state in status and status --json (#2284)

import { afterEach, describe, expect, it, vi } from 'vitest';

import { statusJsonSchema } from './json-contract.js';
import { h, installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli status disk guard (#2284)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prints DISK LOW in the Health band and low:true in --json when below the threshold', async () => {
    vi.stubEnv('FACTORY_MIN_FREE_GB', '100000000');
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] })) as never;
    await runMain('status');
    const out = logged();
    expect(out.slice(out.indexOf('== Health =='))).toContain('DISK LOW: free=');

    vi.mocked(console.log).mockClear();
    await runMain('status', '--json');
    const json = JSON.parse(logged().trim());
    expect(json.disk).toMatchObject({ thresholdGb: 100000000, low: true });
    expect(statusJsonSchema.parse(json)).toEqual(json);
  });

  it('prints nothing new when the guard is disabled', async () => {
    vi.stubEnv('FACTORY_MIN_FREE_GB', '0');
    h.octokit.rest.pulls.list = vi.fn(async () => ({ data: [] })) as never;
    await runMain('status');
    expect(logged()).not.toContain('DISK LOW');
  });
});
