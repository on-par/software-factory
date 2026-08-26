# Factory Daemon: Multi-Repo Architecture Overview

**For:** Patrick · **Date:** 2026-08-18 · **Grounded in:** `packages/core`, `packages/cli`, `packages/server` (stub), epic #583, stories #591/#592, and the two live deployments (software-factory, sound-buddy)

## Executive Summary

Recommendation in five sentences: build one long-lived local daemon (`factoryd`) that owns a **registry of attached repos**, runs one instance of the existing `packages/core` engine per attached repo, and exposes a single localhost HTTP + SSE surface that every UI (web, Electron, CLI `watch`, later mobile) speaks to. Keep each repo's `.factory/` directory exactly where it is — the daemon *orchestrates* N self-contained repo engines rather than centralizing their state — but pull two things up to the daemon level: the repo registry itself, and **usage-cap coordination**, which is account-scoped today but tracked redundantly per repo. Don't invent a new "streams" concept: lanes already are the streams Patrick is describing; the only new work is making them addressable as `(repo, lane)` instead of bare `lane`. Ship #591/#592 as single-repo phase 1, but with three cheap contract changes (repo field in every event envelope, daemon-not-engine process lifetime, attach-style server API) so multi-repo is an additive phase 2 instead of a rewrite. The daemon replaces the cron+tmux relaunch hack — which has left roughly 400 `queue.bak.relaunch-*` backup files in this repo's `.factory/` directory as a monument to why it needs to die.

---

## 1. Addressing: how a lane is identified

**Recommendation: hierarchical `(repoId, laneId)`, rendered as `owner/name#laneId` where a flat string is needed.**

Today a lane is a bare string — `lane: string` on events in `packages/core/src/types/index.ts` — which is fine because the process boundary *is* the repo boundary. Once one daemon manages many repos, every event, API route, and UI element needs a repo qualifier.

- **`repoId`** should be the GitHub slug (`on-par/sound-buddy`), not a local filesystem path and not a generated UUID. It's stable, human-readable, already unique within an account's world, and it's what the engine uses to talk to GitHub anyway. The daemon registry maps slug → local checkout path; the path is an implementation detail that never leaks into the API.
- **`laneId`** stays repo-local (lane-1, lane-2, …), exactly as today. Lane ids don't need global uniqueness; the tuple does.
- **Canonical string form** for URLs, SSE filters, and logs: `on-par/sound-buddy#lane-2`.

Reject the flat-namespace alternative (globally unique lane ids like `lane-9f3a`): it forces every consumer to carry a lookup table just to answer "which repo is this?", which is the first question every UI screen asks. The hierarchy matches how you'll actually navigate: pick a repo, see its lanes.

## 2. State model: per-repo `.factory/` vs. centralized

**Recommendation: keep per-repo `.factory/`, add a small daemon-level directory (`~/.factory/`) for the two genuinely cross-repo things.**

The engine's state is already cleanly repo-scoped: `queue`, `config.json`, `events.ndjson`, `costs.jsonl`, `plans/`, `reports/`, `breaker.json`, worktrees. This is a *feature*, not legacy debt:

- **It's self-describing and portable.** A repo checkout plus its `.factory/` is a complete unit. You can still run `factory run` manually inside a repo for debugging, and the today's-two-cron-jobs world degrades gracefully during migration.
- **It avoids a migration.** Centralizing means rewriting every path assumption in `packages/core` (config loading in `src/config/repo.ts`, queue, events, breaker) and migrating two live deployments, for no user-visible benefit.
- **It keeps blast radius small.** A corrupted queue, a runaway breaker, or a bad config edit in sound-buddy's `.factory/` can only break sound-buddy's lanes. Centralize the state and you've built one file that, when it goes sideways, takes down every repo the daemon manages — the exact failure mode the per-repo layout makes structurally impossible today. The 400+ `queue.bak.*` files in this repo's `.factory/` are ugly, but every one of them was a software-factory-only incident; sound-buddy never noticed.

What genuinely doesn't belong in any single repo — this is the entire contents of `~/.factory/`:

- **The repo registry** (`~/.factory/registry.json`): the map of attached repos — slug → checkout path, attach time, enabled/paused flag. No repo can own the list of *other* repos; it's daemon state by definition.
- **Shared usage-cap state** (`~/.factory/usage/`): the account-level Claude 5-hour window is one signal for one account, but today both software-factory and sound-buddy independently poll it and independently guess how much headroom they have (section 4). The cache, the grant ledger, and the arbiter's state are account-scoped, so they live at the account level.
- **Daemon operational files** (`~/.factory/daemon.log`, `daemon.pid`, `daemon.sock` or a port file): the daemon's own logs, pidfile, and control socket. Today's equivalents — `relaunch-cron.log`, tmux session names, the `relaunch-armed` sentinel — are scattered one-per-repo because each repo *is* its own process supervisor. The daemon collapses that to one process with one set of operational files.

That's it. Resist the temptation to promote anything else. If a piece of state can be answered by "which repo does this belong to?", it stays in that repo's `.factory/`.

## 3. Attaching and detaching repos

**Recommendation: phase 1 attach = register an existing local checkout; detach = drain, never kill.**

**Attach** is a registry write plus an engine start, nothing more: `POST /repos {"repo": "on-par/sound-buddy", "path": "~/repos/on-par/sound-buddy"}`. The daemon validates that the path is a git checkout whose `origin` matches the slug, that `.factory/config.json` exists (or offers to `factory init` it), records the mapping in `~/.factory/registry.json`, and spins up an engine instance rooted at that path. Because all engine state is already cwd-relative per section 2, "spin up an engine" is exactly what `factory run` does today, just with the daemon as parent instead of tmux.

Clone-on-attach — hand the daemon a slug it clones itself into a managed location — is a natural later increment and the API shape above already accommodates it (make `path` optional; the daemon picks `~/.factory/checkouts/<slug>` or similar). Don't build it in phase 1: both live deployments have checkouts, and clone-on-attach drags in credential management and disk-placement policy that phase 1 doesn't need.

**Detach must drain, not kill.** A lane mid-BUILD holds real external state: a worktree with uncommitted work, possibly an open draft PR, a spec frozen in `plans/`. `DELETE /repos/on-par/sound-buddy` should mean: stop pulling new issues from that repo's queue, let in-flight lanes run to their next safe boundary (merged, parked, or awaiting-review — the terminal-ish states in `RunStatus`), then stop the engine and mark the registry entry detached. Offer `?force=true` for the rare genuinely-wedged case, with the explicit contract that force-detach may orphan worktrees and draft PRs. The `.factory/` directory is never touched by detach — the repo remains a complete, re-attachable unit, which also makes attach/detach a safe migration and rollback mechanism during the cutover from cron.

**Pause** is worth having as a distinct verb (`POST /repos/<slug>/pause`): today "pause sound-buddy" means Patrick hand-editing crontab comment lines — the live crontab literally contains `# PAUSED 2026-08-18 (Patrick: pausing sound-buddy factory cron while running a manual all-Sonnet-5 pass)`. Pause = stay attached, stay observable over SSE, dispatch nothing new.

## 4. The UsageCoordinator

**Recommendation: one daemon-level component is the sole reader of the account usage signal and the sole grantor of capacity; engines ask, they don't guess.**

This is the piece with a live failure mode *today*, not hypothetically. `packages/core/src/usage/subscription.ts` reads the same 5-hour rate-limit window Claude Code's own `/usage` UI shows — `fetchSubscriptionUsage()` returns `{ fiveHourUtilization, fiveHourResetsAt }` via the OAuth token in the keychain. It is an **account-level** signal. But it's called from inside each repo's engine, so when software-factory and sound-buddy run simultaneously, two processes independently poll the same number, independently decide "there's headroom," and independently launch expensive phases into the same shrinking window. Neither can see the other's in-flight commitments, so both discover the cap the expensive way: mid-phase failures feeding each repo's separate `breaker.json`.

The fix is structural, not smarter guessing. A `UsageCoordinator` living in the daemon, state under `~/.factory/usage/`:

- **Single reader.** The coordinator is the only caller of `fetchSubscriptionUsage()`. One poll loop, one cached view of `fiveHourUtilization` / `fiveHourResetsAt`, instead of N engines hammering the OAuth endpoint with N independent, mutually inconsistent snapshots.
- **Admission control.** Before starting a phase or switching to a capped model, an engine calls `acquire({repo, lane, phase, model}) → granted | denied({retryAfter})`. Grants for capped models are recorded in a small ledger (`~/.factory/usage/grants.json`) with an estimated cost, so the coordinator's headroom math accounts for work that's *committed but not yet reflected* in the provider's utilization number — the blind spot that makes independent polling unsafe. `denied` carries `retryAfter` derived from `fiveHourResetsAt`, so an engine parks the lane with a real wake-up time instead of retry-thrashing.
- **Policy lives in one place.** "Stop granting Claude above 85% utilization," "reserve the last 10% for FINISH phases," "prefer the codex route when the window is tight" — today these can only be per-repo config heuristics that don't compose across repos. As coordinator policy they compose by construction. This is also where the existing zero-claude/codex-only tail pattern becomes a rule instead of a manual intervention.
- **Engines already have the seam.** The engine already consults usage before model decisions; the change is replacing "call `fetchSubscriptionUsage()` and decide locally" with "call the coordinator and obey." In single-repo standalone mode (`factory run` with no daemon), the engine falls back to exactly today's local behavior — the coordinator is an interface with a daemon implementation and a local implementation, not a hard dependency.

Non-Claude routes need only pass-through treatment initially: codex quota is untracked today, and the coordinator shouldn't pretend to know numbers it doesn't have. The value is concentrated entirely on the one signal we *can* read, which is also the one currently being double-spent.

## 5. Streams of work: lanes already are the concept

**Recommendation: nothing new. The "multiple streams of work" Patrick is reaching for is the lane abstraction that already exists; it just needs the section-1 addressing.**

A lane is an independent worker that claims an issue, gets a worktree, runs PLAN→BUILD→CHECK→SHIP, and reports events — that *is* a stream of work. The engine already runs several per repo in parallel, already serializes their merges, already parks and resumes them. `IssueRunState` in `packages/core/src/types/index.ts` already carries `lane`, `worktree`, `branch`, `status` — everything a stream needs.

The trap to avoid is inventing a second, overlapping concept ("workstreams," "tracks," "channels") at the daemon level. That would give every UI two grouping mechanisms with a fuzzy boundary and force an answer to "is this a lane thing or a stream thing?" for every future feature. The honest model is a two-level tree: **repos have lanes**. The daemon adds the repo level; the lane level is untouched. Per-repo lane count stays where it is today — repo config in `.factory/config.json` — because how much parallelism a repo can sustain is a property of that repo (test-suite cost, merge-train tolerance, branch protections), not of the daemon.

## 6. Event and API surface

**Recommendation: one SSE surface, namespaced by repo — clients choose a per-repo subscription or a repo-tagged firehose.**

- `GET /events?repo=on-par/sound-buddy` — events for one repo. This is what a repo-detail dashboard page subscribes to.
- `GET /events` — the firehose: every event from every attached repo. This is what an all-repos overview, the CLI `watch`, and log shippers subscribe to.
- Every event carries `repo` in its envelope **in both modes**, even in the filtered stream where it's redundant. Redundant-but-uniform beats compact-but-contextual: clients get one parser, and a client can widen from per-repo to firehose without changing its event handling.

This is deliberately a thin extension of #592's design, not a replacement: still SSE over localhost (one-directional traffic, effectively one viewer, free auto-reconnect — #592's WebSocket rejection holds), still `Last-Event-ID` resume, with the id scheme made per-repo-monotonic so resume works identically on filtered and firehose streams. Control actions stay plain POSTs, now repo-scoped: `POST /repos/<owner>/<name>/lanes/<laneId>/pause`, etc. The registry surface from section 3 (`GET /repos`, `POST /repos`, `DELETE /repos/<slug>`) completes the API. Everything binds to localhost; auth remains #583's later polish item.

One housekeeping note: `packages/server/src/index.ts` currently documents itself as a "Phase 2 SaaS webhook" server (Docker/Daytona sandboxes, webhook verification, BullMQ). That concept is unrelated to what #592 builds and the README/stub comments should be rewritten when #592 lands, so the package doesn't describe an architecture nobody is building.

## 7. Build order: ship #591/#592 now, with three cheap contract changes

**Recommendation: do not block the single-repo dashboard on any of this. Ship #591 (event bus — PR #752 is already open) and #592 (SSE server) as scoped, and make exactly three forward-compatible changes that cost hours now and save a rewrite later.**

1. **Every event envelope carries a `repo` field from day one.** #591's payload is `{ ts, laneId, issueId, phase, status, detail, worktreePath }`; add `repo: string` (the GitHub slug), populated from the engine's own repo identity, even though every event in phase 1 has the same value. Retrofitting a field into an event schema after clients exist means versioning the envelope and dual-parsing; adding it now means one line in one type and one line at the emit site.
2. **The SSE server's lifetime is daemon-shaped from the start.** Build #592's `createServer()` as a process that *outlives* any single engine run — started once, engines connect/disconnect to feed it — not as something `factory run` spawns and tears down. Even while the only "daemon" is still the cron+tmux hack, keeping the server's lifecycle decoupled from the engine's means phase 2 changes who *starts* the server, not how it *works*. The alternative bakes in server-per-run, which is exactly the coupling multi-repo has to break.
3. **The server's HTTP API is shaped as attach/list-repos even when one repo is hardcoded.** Phase 1 ships `GET /repos` returning a single hardcoded entry and routes like `/events?repo=<slug>` that accept only that one value. Clients therefore write repo-aware navigation and subscriptions from their first line of code. Phase 2 makes `POST /repos` real; no client changes.

Then the phase-2 sequence, in order: daemon skeleton + registry + attach/detach (section 3) → engines run as daemon children, cron/tmux retired (section 8) → UsageCoordinator (section 4 — first in line after the skeleton because it's the live-risk item) → multi-repo SSE unification (section 6, mostly already done if the three changes above shipped).

## 8. Deployment model

**Recommendation: one persistent `factoryd` process under launchd, replacing N cron+tmux relaunch loops with one supervised daemon.**

Persistence today is a per-repo `relaunch-if-dead.sh` fired by cron every 10 minutes, checking a tmux session and an `events.ndjson` mtime staleness heuristic, guarded by a `relaunch-armed` sentinel file. It works, but the crontab is the management UI (pausing a repo = commenting out its line), each relaunch re-snapshots the queue (the 400+ `queue.bak.relaunch-*` files), the 10-minute poll means up to 10 minutes of dead air per crash, and every new repo means another copy of the script.

The daemon formalizes the same idea at the right level:

- **launchd owns `factoryd`** (`~/Library/LaunchAgents/com.onpar.factoryd.plist`, `KeepAlive=true`, `RunAtLoad=true`). This is macOS's native version of the cron hack: automatic restart on crash with no polling gap, one supervised process instead of a crontab full of shell scripts. On Linux later, the same shape is a systemd user unit; cron `@reboot` + a single relaunch check remains a workable lowest common denominator.
- **The daemon supervises engines**, applying the same liveness ideas `relaunch-if-dead.sh` uses (activity staleness on the event stream) but in-process, per repo, with restart events published over SSE instead of buried in per-repo `relaunch-cron.log` files. Sentinel/pause state moves from filesystem flags to registry fields flipped over the API.
- **Logs and pid** live in `~/.factory/` per section 2; `factory daemon status|start|stop|logs` in `packages/cli` wraps launchctl so nobody has to remember plist paths.
- **Migration is incremental by construction:** attach software-factory to the daemon and delete its cron line while sound-buddy keeps running on cron untouched; when the daemon has proven itself for a week, attach sound-buddy and delete the last cron line. Rollback at any point is "re-add the cron line" — because per-repo `.factory/` state was never moved, the old world still works.
