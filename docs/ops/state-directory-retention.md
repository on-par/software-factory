# State directory retention

Long-running hosts accumulate rename-aside files in the state root (`.factory/`). The state backup pruner bounds them.

## What counts as a backup kind

Top-level regular files in the state root, grouped by kind:

- `queue.bak.relaunch-*` (kind `queue.bak.relaunch`)
- `*-relaunch.log` (kind `relaunch-log`)
- any other name containing `.bak` after a non-empty prefix, grouped by the prefix plus `.bak` (`config.json.bak.20250701` is kind `config.json.bak`, `queue.bak3` is kind `queue.bak`)

## Retention rule

Per kind, the newest `worktree.stateBackupKeep` files (default 3) are kept, and so is anything newer than `worktree.stateBackupMaxAgeDays` (default 7). Everything else is removed.

## Never touched

- live `config.json`, `config.yaml`, `config.yml`, `queue`, `queue.proposed` and `constitution.md`
- any directory, including `state/` and `quarantine/`
- symlinks

## Running it

- `factory worktree gc` previews the state backups it would remove and deletes nothing.
- `factory worktree gc --prune-state-backups` deletes them (`--dry-run` keeps it a preview).
- The automatic pre-run GC (`worktree.autoGcOnRun`) applies the prune and logs a `worktree-gc` event with the removed and kept counts.

## Overriding

```yaml
worktree:
  stateBackupKeep: 5
  stateBackupMaxAgeDays: 14
```
