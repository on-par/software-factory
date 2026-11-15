export interface WorktreeDefaults {
  parent: string;
  comment: string;
  gcTtlDays: number;
  autoGcOnRun: boolean;
  retainMax: number;
  stateBackupKeep: number;
  stateBackupMaxAgeDays: number;
}

export const defaultWorktree: WorktreeDefaults = {
  parent: '~/.factory/worktrees',
  comment:
    'Where lane worktrees are created. "~/..." or an absolute path is a shared root, namespaced as <parent>/<owner>/<repo>/. ' +
    'A repo-relative path is used as-is: "../" gives the old sibling layout; ".factory/worktrees" keeps them inside the repo ' +
    "(auto-added to .git/info/exclude) but the repo's own tools (jest, eslint, tsc, globbing scripts) may crawl into those nested checkouts. " +
    'retainMax (default 8, 0 = no count budget) bounds how many finished or failed lane worktrees a repo keeps. ' +
    'Clean, fully pushed ones are evicted oldest first, and all eligible ones are evicted when the disk guard trips (#3970). ' +
    'stateBackupKeep (default 3) and stateBackupMaxAgeDays (default 7) bound rename-aside backup files (*.bak*, queue.bak.relaunch-*, *-relaunch.log) in the state root: the newest N of each kind and anything newer than the age are kept (#4055).',
  gcTtlDays: 7,
  autoGcOnRun: true,
  retainMax: 8,
  stateBackupKeep: 3,
  stateBackupMaxAgeDays: 7,
};
