import type { EventKind, FactoryConfig } from '@on-par/factory-core';
import { formatStateBackupPruneReport, logEvent, pruneStateBackups } from '@on-par/factory-core/internal';
import type { StateBackupPolicy, StateBackupPruneReport } from '@on-par/factory-core/internal';

export function stateBackupPolicyFrom(cfg: Pick<FactoryConfig, 'worktree'>): StateBackupPolicy {
  return { keep: cfg.worktree.stateBackupKeep, maxAgeDays: cfg.worktree.stateBackupMaxAgeDays };
}

export function autoPruneStateBackups(
  root: string,
  cfg: Pick<FactoryConfig, 'worktree'>,
  emit: (type: EventKind, msg: string) => void,
): StateBackupPruneReport | null {
  try {
    const report = pruneStateBackups(root, stateBackupPolicyFrom(cfg), { dryRun: false });
    if (report.removed.length + report.kept.length > 0) {
      const failed = report.failed.length > 0 ? `, ${report.failed.length} failed` : '';
      emit('worktree-gc', `pruned ${report.removed.length} state backup file(s), kept ${report.kept.length}${failed}`);
    }
    return report;
  } catch (err) {
    emit('warn', `state backup prune failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function appendAutoPrune(
  text: string,
  paths: { root: string; events: string },
  cfg: Pick<FactoryConfig, 'worktree'>,
  scope: Parameters<typeof logEvent>[2],
): string {
  autoPruneStateBackups(paths.root, cfg, (type, msg) => logEvent(paths.events, type, scope, msg));
  return text;
}

export interface WorktreeGcOptions {
  dryRun?: boolean;
  ttlDays?: string;
  branchPrefix?: string;
  pruneStateBackups?: boolean;
}

export function stateBackupGcReport(
  root: string,
  cfg: Pick<FactoryConfig, 'worktree'>,
  opts: WorktreeGcOptions,
): string {
  const dryRun = opts.dryRun === true || opts.pruneStateBackups !== true;
  return formatStateBackupPruneReport(pruneStateBackups(root, stateBackupPolicyFrom(cfg), { dryRun }));
}
