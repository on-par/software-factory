import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface StateBackupPolicy {
  keep: number;
  maxAgeDays: number;
}

export interface StateBackupFile {
  name: string;
  path: string;
  kind: string;
  mtimeMs: number;
}

export interface StateBackupPruneReport {
  dir: string;
  dryRun: boolean;
  removed: StateBackupFile[];
  kept: StateBackupFile[];
  failed: { path: string; error: string }[];
}

const LIVE_NAMES = new Set(['config.json', 'config.yaml', 'config.yml', 'queue', 'queue.proposed', 'constitution.md']);

function classifyStateBackup(name: string): string | null {
  if (LIVE_NAMES.has(name)) return null;
  if (name.startsWith('queue.bak.relaunch-')) return 'queue.bak.relaunch';
  if (name.endsWith('-relaunch.log')) return 'relaunch-log';
  const i = name.indexOf('.bak');
  if (i > 0) return name.slice(0, i) + '.bak';
  return null;
}

function planPrune(
  files: StateBackupFile[],
  policy: StateBackupPolicy,
  nowMs: number,
): { removed: StateBackupFile[]; kept: StateBackupFile[] } {
  const groups = new Map<string, StateBackupFile[]>();
  for (const f of files) {
    const group = groups.get(f.kind);
    if (group) group.push(f);
    else groups.set(f.kind, [f]);
  }
  const removed: StateBackupFile[] = [];
  const kept: StateBackupFile[] = [];
  const maxAgeMs = policy.maxAgeDays * 86_400_000;
  for (const group of groups.values()) {
    group.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    group.forEach((f, index) => {
      if (index < policy.keep || nowMs - f.mtimeMs < maxAgeMs) kept.push(f);
      else removed.push(f);
    });
  }
  return { removed, kept };
}

function emptyReport(dir: string, dryRun: boolean): StateBackupPruneReport {
  return { dir, dryRun, removed: [], kept: [], failed: [] };
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

export function pruneStateBackups(
  dir: string,
  policy: StateBackupPolicy,
  opts: { dryRun?: boolean; now?: () => number } = {},
): StateBackupPruneReport {
  const dryRun = opts.dryRun === true;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (isEnoent(err)) return emptyReport(dir, dryRun);
    throw err;
  }
  const candidates: StateBackupFile[] = [];
  for (const name of names) {
    const kind = classifyStateBackup(name);
    if (kind === null) continue;
    const path = join(dir, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    candidates.push({ name, path, kind, mtimeMs: st.mtimeMs });
  }
  const plan = planPrune(candidates, policy, (opts.now ?? Date.now)());
  const failed: { path: string; error: string }[] = [];
  const removed: StateBackupFile[] = [];
  for (const f of plan.removed) {
    if (dryRun) {
      removed.push(f);
      continue;
    }
    try {
      unlinkSync(f.path);
      removed.push(f);
    } catch (err) {
      failed.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  removed.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, dryRun, removed, kept: plan.kept, failed };
}

export function formatStateBackupPruneReport(report: StateBackupPruneReport): string {
  if (report.removed.length + report.kept.length + report.failed.length === 0) {
    return `state backups: none in ${report.dir}`;
  }
  const header = report.dryRun
    ? `state backups in ${report.dir}: would remove ${report.removed.length}, keep ${report.kept.length} (dry run; pass --prune-state-backups to delete)`
    : `state backups in ${report.dir}: removed ${report.removed.length}, kept ${report.kept.length}`;
  const lines = [header];
  for (const f of report.removed) lines.push(`  - ${f.name}`);
  for (const f of report.failed) lines.push(`  ! ${f.path.slice(report.dir.length + 1)}: ${f.error}`);
  return lines.join('\n');
}
