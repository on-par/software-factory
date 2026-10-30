# Run lock

The run lock stops two factory processes from force-recreating the same per-issue worktree and branch (#598, #683), which destroys a live run's in-flight work. It is fail-fast: a live holder is refused immediately and never queued behind, and a dead holder's lock is reclaimed through the ADR-0009 fenced steal (`lock-stolen` event). Nested acquisition in one process is a pass-through.

## Two tiers (#3643)

| Tier     | Path                           | Commands                                    |
| -------- | ------------------------------ | ------------------------------------------- |
| Checkout | `.factory/run.lock`            | `run`, `supervise`, `local-small-overnight` |
| Issue    | `.factory/locks/run/<WorkKey>` | `ship`, `run-issue`, `run-brief`, `resume`  |

Originally every command shared one checkout lock, so a second one-shot run was refused even for a different issue, whose worktree and branch are disjoint. One-shot runs now lock per WorkKey (ADR-0168), so different issues run in parallel on one checkout and the same issue still refuses. `run-brief` with several files takes each brief's lock in turn, one brief at a time, so a refused lock fails only that brief and the next one still runs. The WorkKey is path-safe and config-independent. A worktree path is not used as the key because it depends on `worktree.parent` and the branch prefix (ADR-0150), so two processes with different prefixes would get different keys for the same issue.

### Stacked briefs (`--stack`)

`factory run-brief a.md b.md c.md --stack` opens the briefs as a PR stack: a.md's PR targets the trunk (or `--base-branch`), b.md's targets a.md's PR head branch, c.md's targets b.md's. Each layer reuses the `--base-branch` path: the worktree starts from `origin/<previous head>`, BUILD and CHECK diff against that parent via `parentBaseRef` (the same parent-base mechanism as the ADR-0161 stack slices), and the PR targets the previous head. The size gate is off for every brief. A failed brief, or one that opens no PR (for example `--no-pr`), stops the stack: the remaining briefs are skipped and reported, and the command exits 1. `--stack` cannot combine with `--workspace`, and with a single brief it slices an over-budget brief and builds the slices as a stack in one run, keeping the slice plan in `.factory/state/slice-plans/<run number>.md` instead of an issue comment (#3813).

Brief stacks have no issue slice-plan comment, so the factory's `restackAfterSquashMerge` and the queue/land restack hook do not run for them. Merge bottom-up; GitHub's native stacked-PR support rebases the upper layers and retargets the next PR to the trunk after a squash merge. If review changes a lower layer, re-run the upper briefs.

### Stacked issues (`run-issue --stack`)

`factory run-issue 42 --stack` (the same as `--size-gate stack`) builds an oversized issue as a PR stack in one run. When the issue has no slice plan yet, a sizing run lets the PLAN phase slice it (ADR-0165); an issue that fits the budget ships as one PR and the command ends there. Otherwise every pending slice is built in order inside the one run lock, with no release between slices: slice 1 bases on `--base-branch` or the trunk, and each later slice bases on the previous slice's PR head. Each slice still goes through the full PLAN, BUILD, CHECK and SHIP. The first failed or parked slice stops the stack: the remaining slices are skipped and reported, and the command exits 1. `--no-pr` exits 2, because every slice opens a PR. A plain `run-issue` builds one slice per run, because stack is the default `sizeGate.mode`.

`run`, `supervise` and `local-small-overnight` pick issues from the queue, so they cannot know their key up front. They keep the checkout-wide fence.

## Cross-tier rule

A scoped acquire takes its own lock first, then checks the other tier:

- an issue lock is refused while another process holds a live checkout lock;
- the checkout lock is refused while another process holds any live issue lock.

Acquire-then-check means two racing tiers can both refuse but never both proceed. The refusing side releases its own lock. Holders with the current pid are ignored.

Parallel one-shot runs are still bounded by claims and `host.maxBuilds` slots.

## Self-update

`factory self-update` and factoryd auto-update wait while any checkout or issue lock has a live holder.

## Clearing a stale lock

A lock left by a dead pid is reclaimed automatically. Remove the directory named in the error (`.factory/run.lock` or `.factory/locks/run/<WorkKey>`) only if you are sure no factory run is live.

## Fleet leader for blocked-park auto-unpark (#3147)

When several hosts share one repo, each runs the blocked-park poller (`factory doctor --reconcile`), so two hosts can unpark the same issue. Set `FACTORY_FLEET_LEADER=<hostname>` on every host to name the one that polls; the others skip the poll and print `blocked-park poll skipped: this host is not the fleet leader`. The match is case-insensitive. Unset or blank keeps today's behaviour (every host polls). A wrong value silently disables auto-unpark on the hosts that do not match it.

Enqueue also repairs races after it writes: it keeps one `factory:order:<n>` label per issue and moves the higher-numbered issue off a shared position, logging `order_collision_repaired`.

## Known limitation

`run-flags.json` (used by `factory status` for draft-PR attribution) is per checkout and written without a lock, so across parallel one-shot runs it is last-writer-wins. It is display-only. `events.ndjson` is append-only.
