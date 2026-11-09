import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errored, installShipHarness, logged, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

// Capture the deprecation line the deprecated `--size-gate slice` alias writes, so the alias test proves it
// without the verify worker's real stderr carrying it (#4011).
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});
const warned = () => warnSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

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

  it('run-issue --no-pr with --size-gate stack exits 2 before any phase runs', async () => {
    const res = await runMain('run-issue', '5', '--no-pr', '--size-gate', 'stack');
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--stack opens a PR per slice');
    expect(warned()).toBe('');
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('run-issue --no-pr still fails closed with exit 2 on the deprecated --size-gate slice alias (#4011)', async () => {
    const res = await runMain('run-issue', '5', '--no-pr', '--size-gate', 'slice');
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--stack opens a PR per slice');
    expect(warned()).toContain("size gate mode 'slice' is deprecated");
    expect(phases.planPhase).not.toHaveBeenCalled();
  });
});
