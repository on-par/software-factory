// packages/core/src/worktree/internal-exports.ts — worktree retention surface re-exported by internal.ts (#3970)
export { readHostBuildSlots } from '../environment/host-slots.js';
export { listFactoryWorktrees } from './worktree-gc.js';
export {
  reclaimRetainedWorktrees,
  resolveRetentionPolicy,
  retentionCandidateOf,
  selectRetentionEvictions,
  type RetentionCandidate,
  type RetentionPolicy,
  type RetentionProtection,
  type RetentionReport,
  type RetentionSelection,
} from './worktree-retention.js';
