// packages/cli/src/cli/test-support/doctor-harness.ts — ship harness plus the doctor-only fakes (#2799)
import { beforeEach, vi } from 'vitest';

import type { CliDeps } from '../index.js';
import { h as shipH, installShipHarness, runMainWith as shipRunMainWith } from './ship-harness.js';

export * from './ship-harness.js';

/** The ship harness state, extended with the fields the doctor fakes read from. */
export const h = Object.assign(shipH, {
  orphanContainers: [] as Array<{ id: string; name: string }>,
  reapedContainers: [] as Array<{ id: string; name: string; removed: boolean; detail: string }>,
  orphanVmNames: [] as string[],
  reapedVms: [] as Array<{ name: string; removed: boolean; detail: string }>,
  gcReport: { removed: [], kept: 0, dryRun: false } as any,
  staleClaims: [] as any[],
  greenPrs: [] as any[],
});

function makeInternalFakes() {
  return {
    sweepWorktrees: vi.fn(async () => h.gcReport) as any,
    releaseStaleClaims: vi.fn(async () => h.staleClaims) as any,
    findUnmergedGreenPrs: vi.fn(async () => h.greenPrs) as any,
    listOrphanContainers: vi.fn(async () => h.orphanContainers) as any,
    reapOrphanContainers: vi.fn(async () => h.reapedContainers) as any,
    listMicroVms: vi.fn(async () => h.orphanVmNames),
    reapOrphanMicroVm: vi.fn(
      async (name: string) =>
        h.reapedVms.find((r) => r.name === name) ?? { name, removed: true, detail: `sbx rm --force ${name} ok` },
    ) as any,
    exec: vi.fn(async (cmd: string) => ({ stdout: h.execImpl(cmd), stderr: '' })),
    execSync: vi.fn((cmd: string) => h.execSyncImpl(cmd)),
    octokit: () => h.octokit,
    readCosts: vi.fn(() => h.costs) as any,
  } satisfies Pick<
    CliDeps,
    | 'sweepWorktrees'
    | 'releaseStaleClaims'
    | 'findUnmergedGreenPrs'
    | 'listOrphanContainers'
    | 'reapOrphanContainers'
    | 'listMicroVms'
    | 'reapOrphanMicroVm'
    | 'exec'
    | 'execSync'
    | 'octokit'
    | 'readCosts'
  >;
}
/** Fresh fakes per test, spread into every main call. */
export let ops = makeInternalFakes();

export async function runMainWith(deps: CliDeps | undefined, ...args: string[]) {
  return shipRunMainWith({ ...ops, ...deps }, ...args);
}

/** installShipHarness plus the per-test reset of the doctor fakes and h fields. */
export function installDoctorHarness(): void {
  installShipHarness();
  beforeEach(() => {
    ops = makeInternalFakes();
    h.gcReport = { removed: [], kept: 0, dryRun: false };
    h.staleClaims = [];
    h.greenPrs = [];
    h.orphanContainers = [];
    h.reapedContainers = [];
    h.orphanVmNames = [];
    h.reapedVms = [];
  });
}
