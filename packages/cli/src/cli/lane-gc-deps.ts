import type { FactoryConfig } from '@on-par/factory-core';
import type { logEvent, sweepWorktrees } from '@on-par/factory-core/internal';

import type { retentionBudgetPass } from './worktree-retention.js';

export interface LaneGcDeps {
  loadConfig?: (configPath: string) => Pick<FactoryConfig, 'worktree' | 'sandbox' | 'run'>;
  sweep?: typeof sweepWorktrees;
  emitEvent?: typeof logEvent;
  octokit?: () => NonNullable<Parameters<typeof sweepWorktrees>[1]>['octokit'];
  reclaim?: Parameters<typeof retentionBudgetPass>[0];
  protectedIssues?: () => ReadonlySet<number>;
}
