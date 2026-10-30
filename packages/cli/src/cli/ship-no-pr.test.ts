import { describe, expect, it } from 'vitest';

import { errored, installShipHarness, logged, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('ship --no-pr', () => {
  it('stops after CHECK: no shipPhase, no BUILD publishing, size gate off', async () => {
    const res = await runMain('ship', '5', '--no-pr');
    expect(res.exited).toBe(false);
    expect(phases.checkPhase).toHaveBeenCalled();
    expect(phases.shipPhase).not.toHaveBeenCalled();
    const build = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
    expect(build.disablePublish).toBe(true);
    const plan = phases.planPhase.mock.calls.at(-1)?.[0] as any;
    expect(plan.enforceSizeGate).toBe(false);
    expect(logged()).toContain('--no-pr, SHIP skipped');
  });

  it('run-issue --no-pr with a size gate other than off exits 2 before any phase runs', async () => {
    const res = await runMain('run-issue', '5', '--no-pr', '--size-gate', 'slice');
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--stack opens a PR per slice');
    expect(phases.planPhase).not.toHaveBeenCalled();
  });
});
