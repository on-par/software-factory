// packages/cli/src/cli/status-disk.ts — disk guard reading for `factory status` (#2284); emits nothing.

import type { FactoryConfig } from '@on-par/factory-core';
import {
  evaluateDiskGuard,
  readFreeSpace,
  resolveDiskMinFreeGb,
  resolveWorktreeRoot,
} from '@on-par/factory-core/internal';
import type { DiskGuardDecision, DiskSample } from '@on-par/factory-core/internal';

export interface StatusDisk {
  decision: DiskGuardDecision;
  freeGb: number;
  thresholdGb: number;
}

/** Same paths and threshold as `factory run`. Null when every probe failed. */
export function probeDisk(
  repoRoot: string,
  ghRepo: string,
  statePath: string,
  config: FactoryConfig,
  probe: (path: string) => DiskSample = (p) => readFreeSpace(p),
): StatusDisk | null {
  const samples: DiskSample[] = [];
  for (const p of [resolveWorktreeRoot({ repoRoot, parent: config.worktree.parent, repo: ghRepo }), statePath]) {
    try {
      samples.push(probe(p));
    } catch {
      // an unreadable volume is skipped
    }
  }
  const thresholdGb = resolveDiskMinFreeGb(config);
  const decision = evaluateDiskGuard(thresholdGb, samples);
  return decision.freeGb === null ? null : { decision, freeGb: decision.freeGb, thresholdGb };
}
