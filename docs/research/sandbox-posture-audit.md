# Sandbox posture and threat-model audit (Issue #618)

Date: 2026-08-14

## Purpose and scope

This is a written audit of the v1 OS-level sandbox
(`packages/core/src/sandbox/index.ts`): what it actually stops, what it does
not stop, when it silently does not run at all, which of tonight's runs
(2026-08-13 through 2026-08-14) had containment active vs. degraded vs.
uncontained vs. disabled — taken from the production `events.ndjson` sink — and
the threat surface this implies for autonomous agents holding live GitHub
write/merge credentials. It is the grounding audit for the other
sandbox-discovery stories and is deliberately **not** a design: no next-gen
sandbox proposal, no ADR, no recommendations. All claims are grounded in the
source files cited and the log lines quoted.

## What today's sandbox stops

Source of truth: `packages/core/src/sandbox/index.ts`.

### Write containment

`resolveSandboxPolicy` (`packages/core/src/sandbox/index.ts:59-105`) derives
`writablePaths` as the worktree + `<repoRoot>/.git` + `tmpdir()` +
`~/.claude`, `~/.codex`, `~/.npm`, `~/.cache`, `~/.config`, `~/.local`, plus on
darwin `/tmp`, `/private/tmp`, `/private/var/folders`, `~/Library/Caches`,
`~/Library/Logs` (index.ts:82-95). The macOS Seatbelt profile
`buildDarwinProfile` (index.ts:112-121) emits `(deny file-write*)` with
`(allow file-write* (subpath ...))` rules only for those paths (plus
`/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/fd`). firejail uses
`--read-only=/` with `--read-write=<path>` per writable path (index.ts:137-139).
Result: an agent cannot write outside those directories.

### Resource limits

`wrapCommandInSandbox` (index.ts:125-140) prefixes the wrapped shell with
`ulimit -t <cpuSeconds>` on both runtimes and additionally
`ulimit -v <memMb*1024>` under firejail (index.ts:128-130). Defaults come from
`packages/config/src/factory.json:60` (`resources.cpuMs: 300000`,
`resources.memMb: 4096`), i.e. ~300s of CPU and ~4 GiB of virtual memory per
wrapped run.

### Egress denial — only in one configuration

When `network.allow` is **empty**, the Seatbelt profile adds
`(deny network-outbound)` (index.ts:114) and firejail adds `--net=none`
(index.ts:138). Note: `--net=none` on firejail also drops loopback, breaking
most app-local networking (dev servers, checker probes against a lane's app
port) — the all-egress-denied posture is only practical for fully offline runs.
The shipped default is _not_ this configuration (see "What it does not stop").

### Enforcement visibility

`sandboxEventFromError` (index.ts:148-167) classifies a failed run's
stderr/signal into `sandbox_violation` / `resource_limit`; the router forwards
the classification via `onSandboxEvent` (packages/core/src/router/index.ts:679-681)
and `buildPhase` logs it (packages/core/src/phases/build.ts:149). So a denial
that produces a recognizable stderr string or a `SIGXCPU` signal becomes a
typed, queryable event in the sink.

## What it does not stop

### Network egress to anywhere, whenever the allowlist is non-empty

This is the shipped default (`packages/config/src/factory.json:59`:
`"network": { "allow": ["api.anthropic.com", "github.com"] }`). With a
non-empty allowlist the profile contains **no** network-deny rule at all: the
`(deny network-outbound)` line in `buildDarwinProfile` is only emitted when
`allowHosts.length === 0` (index.ts:114), and firejail's `--net=none` only when
the same condition holds (index.ts:138). The file header comment
(index.ts:5-8) and the CLI's degraded warning (cli/index.ts:1007-1011) both
state the reason: per-host network filtering is "not expressible in either
runtime without a proxy". The allowlist is intended-only — it influences the
log line, not the actual network policy. `sandbox-exec`/`firejail` were given
no proxy through which to enforce it.

### Credential and dependency exfiltration

The wrapped agent process inherits the host env and home directory. It holds a
live GitHub write/merge token (`GITHUB_TOKEN`/`GH_TOKEN`,
packages/cli/src/cli/index.ts:204), model API keys (`ANTHROPIC_API_KEY`,
packages/core/src/harness/catalog.ts:39), and the Codex CLI's own auth material
in `~/.codex` — a directory that `resolveSandboxPolicy` explicitly adds to
`writablePaths` (index.ts:87). With egress open, the agent can exfiltrate any
of these over any channel (curl, git push, DNS). Nothing redacts env or
rate-limits the network. A compromised dependency's `postinstall` script runs
inside the wrapped shell with the same privileges.

### PLAN-phase runs

`shipIssue` passes the active policy only to `buildPhase`
(cli/index.ts:1159) and `checkPhase` (cli/index.ts:1199, threaded into rework
model runs at packages/core/src/phases/check.ts:249 and check.ts:374).
`planPhase` is invoked at cli/index.ts:1093-1113 with **no** sandbox option, so
the boss-model PLAN runs are entirely uncontained.

### Write-scope edges

`writablePaths` includes `~/.npm`, `~/.cache`, `~/.config`, `~/.local` and tmp
(index.ts:82-95). An agent can plant persistent files outside the worktree — an
`.npmrc`, poisoned `node_modules` cache, or dotfiles — that later
un-sandboxed phases and hosts inherit. Reads are unrestricted: the Seatbelt
profile opens with `(allow default)` (index.ts:117), so any file on the host is
readable by the agent.

### Enforcement-signal noise

The violation classifier regex `operation not permitted|read-only file system|sandbox.*deny|deny\(1\) file-write`
(index.ts:143) matches "Operation not permitted" anywhere in stderr, including
inside unrelated tool warnings. This is observable in the production log: **all
14** `sandbox_violation` events in the sink are Codex "WARNING: proceeding,
even though we could not create PATH aliases: Operation not permitted" lines —
no true sandbox denial has ever been recorded, and the classifier fires on
noise. Conversely, a real denial whose stderr matches none of the strings is
swallowed as a generic harness error, and a successful exfiltration leaves no
event at all.

## When it silently does not run at all

### No tool on the host (runtime `'none'`)

`detectSandboxRuntime` (index.ts:33-40) returns `'none'` for any host that
lacks `sandbox-exec` (non-macOS) or `firejail` (non-Linux) — including Windows
unconditionally. `wrapCommandInSandbox` with `runtime: 'none'` returns the
command **unchanged** (index.ts:125-126). `shipIssue` never sets
`activeSandboxPolicy` for runtime `'none'` (cli/index.ts:997-1004), so no
`sandbox` containment event ever fires and the CLI logs
`sandbox-unavailable ... running uncontained` (cli/index.ts:1003-1004). That
event is a `warn` with `isPark: false` and `isTerminal: false`
(packages/core/src/events/kinds.ts:243), so the run proceeds uncontained — the
log's _silence_ about containment is itself the unavailable signal, and it is
easy to miss in a warn stream.

### Explicit disable paths

Two other paths also produce no containment: `--no-sandbox`
(cli/index.ts:998-1000) and `FACTORY_SANDBOX=0` or config `enabled:false`
(`sandboxDisabled`, index.ts:42-51) → `sandbox-disabled`
(cli/index.ts:1001-1002). All three buckets log a posture event but none
contains the agent.

## Tonight's inventory from the logs

Source of truth: the production event sink at
`<repoRoot>/.factory/events.ndjson` (`getFactoryPaths`,
packages/core/src/config/index.ts:373-379; `events` at index.ts:379). For this
repo that is `/Users/moltbot/repos/on-par/software-factory/.factory/events.ndjson`
(not committed). The `sandbox*` event kinds are registered in
packages/core/src/events/kinds.ts:104-108.

### Method

1. Window = tonight's batch, **2026-08-13T00:00:00Z through
   2026-08-14T23:59:59Z**.
2. Extract every event whose `type` is in `sandbox`, `sandbox-degraded`,
   `sandbox-unavailable`, `sandbox-disabled`, `sandbox_violation`,
   `resource_limit`, grouped per `issue` (and `lane` when present).
3. Bucket each run by precedence: `sandbox-disabled` → **disabled**;
   `sandbox-unavailable` → **uncontained**; `sandbox-degraded` → **degraded**
   (containment active, egress open — the honest posture even when a later
   `sandbox` event also fired); else `sandbox` → **active** (containment
   active, egress denied). A run with none of these never reached a
   sandbox-logging point → **no posture event**.

### Extraction commands

Coarse filter, then parse (the sink also contains non-JSON supervisor console
prints; see the caveat below):

```bash
rg '"type":"sandbox' /Users/moltbot/repos/on-par/software-factory/.factory/events.ndjson
```

Full window extraction and bucketing:

```bash
python3 - <<'EOF'
import json, collections
path = "/Users/moltbot/repos/on-par/software-factory/.factory/events.ndjson"
kinds = {"sandbox", "sandbox-degraded", "sandbox-unavailable",
         "sandbox-disabled", "sandbox_violation", "resource_limit"}
start, end = "2026-08-13T00:00:00Z", "2026-08-14T23:59:59Z"
rows = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") in kinds and start <= e.get("ts", "") <= end:
            rows.append(e)
print(collections.Counter(e["type"] for e in rows))
EOF
```

Caveat: 114 lines in the sink fail `json.loads` — they are `[factory]
supervise: ...` console prints written into the NDJSON stream, not events; none
contains the substring `sandbox`, so the counts below are unaffected.

### Per-issue/lane table (recomputed 2026-08-14)

| issue     | lane      | posture events | `sandbox-degraded` | `sandbox` (containment active) | bucket   |
| --------- | --------- | -------------- | ------------------ | ------------------------------ | -------- |
| 425       | readysell | 3              | 3                  | 1                              | degraded |
| 426       | readysell | 1              | 1                  | 1                              | degraded |
| 430       | readysell | 1              | 1                  | 0                              | degraded |
| 606       | growth    | 3              | 3                  | 3                              | degraded |
| 607       | growth    | 3              | 3                  | 3                              | degraded |
| 618       | growth    | 1              | 1                  | 1                              | degraded |
| 640       | bugs      | 3              | 3                  | 2                              | degraded |
| 643       | readysell | 1              | 1                  | 0                              | degraded |
| 665       | techdebt  | 3              | 3                  | 3                              | degraded |
| 666       | techdebt  | 1              | 1                  | 1                              | degraded |
| **Total** |           | **20**         | **20**             | **15**                         |          |

Every one of tonight's **20** runs that reached the posture-logging point
emitted `sandbox-degraded` with the intended allowlist `api.anthropic.com,
github.com` (cli/index.ts:1007-1011), so by the bucketing rule **every run is
`degraded`** — containment active (sandbox-exec), egress fully open. Typical
pair, quoted verbatim:

```
2026-08-14T16:17:47.909Z issue=618 lane=growth type=sandbox-degraded msg=host-level egress filtering unavailable in v1; intended allowlist: api.anthropic.com, github.com
2026-08-14T16:21:27.483Z issue=618 lane=growth type=sandbox msg=containment active (runtime sandbox-exec, net allow-list)
```

15 of the 20 runs reached BUILD and also emitted the `sandbox` "containment
active" event (build.ts:137-142). The 5 runs that logged `degraded` but no
containment-active event in the window never reached BUILD within it: 425 ran
twice that escalated in PLAN (02:58:39, 03:00:43) then succeeded at 03:01:29;
430 escalated in PLAN (03:52:29); 643 started PLAN at 02:57:56 with no
completion recorded in the window; 640's 15:50:12 run failed PLAN
(`empty_response`) and parked.

Zero `sandbox-unavailable` events tonight — this host has `sandbox-exec`, so
the "runs with no OS containment at all" bucket is **0 for the missing-tool
case**. This is stated plainly because it is a property of this host, not
evidence that the unavailable path is safe: 0 `sandbox-unavailable` and 0
`sandbox_violation`/`resource_limit` events exist anywhere in the sink, and the
missing-tool path runs a command **unchanged** (index.ts:125-126). The two
disabled-tool cases are also historical, not tonight: the only 3
`sandbox-disabled` events in the sink are issue 153, lane `core`, on
2026-07-19, all `sandbox disabled by config/FACTORY_SANDBOX`.

### Historical enforcement evidence

All **14** `sandbox_violation` events ever recorded are the Codex PATH-aliases
noise line, e.g.:

```
{"ts": "2026-07-19T12:59:55.077Z", "type": "sandbox_violation", "issue": "201", "msg": "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n..."}
```

No `resource_limit` event has ever been recorded. The enforcement signal today
is therefore noise, not evidence — the sandbox has never demonstrably denied
anything on this host, and nothing in the sink would tell us if an agent
exfiltrated data.

## Threat surface

1. **Network egress to anywhere** — the default allowlist is unenforced, so a
   compromised/malicious dependency or LLM-generated code can phone home; the
   only egress-denied configuration is the empty allowlist, which the shipped
   default never uses.
2. **Credential exfiltration** — live GitHub write/merge token
   (`GITHUB_TOKEN`/`GH_TOKEN`), model API keys, and Codex auth in `~/.codex`
   ride in the agent's env/home and are exfiltratable over any channel once
   egress is open; the sandbox neither redacts env nor rate-limits network.
3. **Dependency supply chain** — the agent runs installs (`npm install`/`npm
ci`) as part of the verify flow; write containment does not stop fetching
   or postinstall code execution.
4. **Write-scope gaps** — `~/.npm`, `~/.cache`, `~/.config`, `~/.local`, and
   tmp are writable; reads are unrestricted (`(allow default)`); an agent can
   plant persistent out-of-worktree artifacts that later, un-sandboxed
   phases/hosts inherit.
5. **Enforcement-signal noise** — the violation classifier fires on unrelated
   "Operation not permitted" text (all 14 recorded events are noise); a true
   denial without a matching string is swallowed as a generic harness error;
   successful exfiltration leaves no event.
6. **Resource exhaustion** — cpu/mem ulimits bound a single run's CPU and VM,
   not disk, fd, or process counts.
7. **No-tool hosts** — a host without `sandbox-exec`/`firejail` runs fully
   uncontained, silently (warn-only `sandbox-unavailable`, never parked).
8. **Uncontained PLAN phase** — boss-model PLAN runs are never wrapped, so a
   PLAN-stage prompt injection or malicious dependency runs with no containment
   at all.

## Grounding for the other discovery stories

This audit establishes the current envelope the follow-on stories' proposals
must close against: write containment works (worktree + `.git` + tmp + the
`~/.` state dirs, enforced by the Seatbelt/firejail profiles at
`packages/core/src/sandbox/index.ts:112-121` and index.ts:137-139); egress is
open-by-default because a non-empty allowlist is never enforced without a proxy
(index.ts:5-8, index.ts:114, cli/index.ts:1007-1011); containment is
host-tool-dependent, with runtime `'none'` passing commands through unchanged
(index.ts:33-40, index.ts:125-126, cli/index.ts:1003-1004); PLAN is unwrapped
(cli/index.ts:1093-1113); and the enforcement signal is currently noise, not
evidence (index.ts:143, all 14 `sandbox_violation` events are Codex PATH-alias
warnings). Any future design must either enforce egress, drop the misleading
allowlist, or make the degraded/unavailable posture a hard stop.

## Discovery artifact, not a design

This document is a discovery artifact for issue #618 only — an audit of the
current envelope and threat surface. It makes no architectural decisions, names
no replacement sandbox, and adds no ADR; the follow-on discovery stories decide
those against this grounding.
