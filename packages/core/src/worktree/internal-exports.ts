// packages/core/src/worktree/internal-exports.ts — worktree retention surface re-exported by internal.ts (#3970)
export { readHostBuildSlots } from '../environment/host-slots.js';
export { reclaimRetainedWorktrees, resolveRetentionPolicy, type RetentionReport } from './worktree-retention.js';
export {
  formatStateBackupPruneReport,
  pruneStateBackups,
  type StateBackupPolicy,
  type StateBackupPruneReport,
} from './state-backup-prune.js';
