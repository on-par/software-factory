# ADR-0167: A repo reads tickets from one configured tracker, and a WorkKey string replaces the numeric issue

- Status: Accepted
- Date: 2026-10-22
- Issue: #3458
- Relates to: ADR-0030, ADR-0042, ADR-0044, ADR-0108, ADR-0119, ADR-0129, ADR-0147, ADR-0156

## Context

The factory reads only GitHub issues. `run-issue` takes a bare number
(`packages/cli/src/cli/index.ts`). The numeric `issue` keys branches, worktrees, events, state
and the `--json` contract, and SHIP writes `Closes #N`. ADR-0108 defined `QueueBackend` but left
non-GitHub backends as "future". The design for a second tracker was settled in a grill-me
session on 2026-10-21. Issues #3459 to #3463 build on it, then #3464 and #3465.

## Decision

### 1. Scope of v1 is single runs only

`run-issue` and `ship` fetch from the configured tracker and run PLAN to SHIP. The PR links the
ticket, and park and failure comments go to the ticket. Queue, lanes, supervisor, claims
(ADR-0044), decompose and ingest stay GitHub-only and refuse to start when `tracker.kind` is not
`github`. A tracker-backed queue through ADR-0108's `QueueBackend` needs its own future ADR.

Rejected: a tracker-backed queue in v1.

### 2. Identity

`WorkKey` replaces `issue: number` in core and CLI.

Rejected: a synthetic number in a reserved band (the run-brief trick, `briefRunNumber`).

### 3. WorkKey shape

A `WorkKey` is a branded native display key with no tracker prefix (`"123"`, `"PROJ-123"`).
There is one tracker per repo, so GitHub keys render as today. Branches stay `factory/123-title`
and no on-disk state migration is needed. The stable id (Jira numeric `id`, Linear UUID) lives in
`WorkRequest.reference`. A ticket moved to another project counts as a new work item.

Rejected: a tracker-qualified string, and a structured object.

### 4. The `--json` contract stays on v1

The change is additive. Add `workKey: string`. Keep `issue: number | null` (a number under
GitHub, `null` otherwise) and mark it deprecated. Removing it is #3464.

Rejected: a v2 contract bump now.

### 5. Closing a ticket is the tracker's own integration's job

The adapter supplies `closesTrailer(key, isFinalSlice)`: GitHub `Closes #N` / `Part of #N`, Jira
and Linear `Closes KEY` / `Part of KEY` (this ties to the slice PRs of ADR-0147 and ADR-0156).
The key goes in the branch, PR title and body. The factory never transitions Jira statuses; teams
own that through the Jira GitHub app or Automation rules.

Rejected: factory-driven status transitions.

### 6. Config

A runtime-namespace key `tracker`, added to `FACTORY_RUNTIME_CONFIG_KEYS` (ADR-0042, ADR-0119),
with `kind: github | jira | linear` (default `github`) and
`jira: { baseUrl, projectKeys, acceptanceCriteriaField? }`. Secrets come from env only
(`JIRA_EMAIL` + `JIRA_API_TOKEN`; `LINEAR_API_KEY` later). Preflight fails fast when they are
missing. `projectKeys` is an allowlist. v1 supports Jira Cloud only.

Rejected: secrets in config, and Jira Server/Data Center in v1.

### 7. Ticket body

Jira ADF is converted to plain text or light Markdown, lossy on purpose, because readiness
becomes a model judgment (#3457). An optional AC custom field is appended as plain context. The
body still reaches PLAN only inside the untrusted block (ADR-0129). The ticket body is never
written back.

Rejected: a lossless ADF rendering.

### 8. CLI input

Each adapter has `parseKey(input)`. GitHub takes `123`, `#123`, or an issue URL for this repo.
Jira takes `PROJ-123` (case-insensitive, normalized to upper case) or
`<baseUrl>/browse/PROJ-123`. A form from another tracker or another host exits 2.

Rejected: a `--tracker` override flag.

### 9. Writes under a non-GitHub tracker

Park, env-failure, readiness and slice-plan comments go through `tracker.comment` (Jira v2
comment endpoint with a plain string). Size gate `decompose` mode is a config error; only `slice`
mode is allowed. Blocker and flaky-test findings become a ticket comment plus an event, never new
tickets. PR labels stay on GitHub. A failed comment warns and never fails the run.

Rejected: filing new tickets.

### 10. Closed-ticket skip (ADR-0030)

A Jira ticket is closed when `statusCategory.key === 'done'`; a Linear ticket when `state.type`
is `completed` or `canceled`. Nothing to configure.

Rejected: a configurable done-status list.

### 11. Testing

One shared tracker contract suite runs against every adapter, using recorded and sanitized
fixtures over a fake HTTP layer. Table tests cover ADF. A `factory tracker check` command checks
auth and fetches one ticket. One stub eval case covers a `tracker: jira` run. No live tracker
runs in CI.

Rejected: live-tracker CI tests.

### 12. Jira first

Jira comes first. Linear is a planned `kind`, filed as #3465 and built when someone needs it.

Rejected: building both adapters at once.

### 13. No MCP for reading tickets

Rejected: reading tickets through a Jira MCP server. The Node pipeline cannot reach a user's
Claude connectors. It would not be deterministic or stub-testable. The Codex harness has no MCP.
Giving a model write access while it reads an untrusted body is a prompt-injection path
(ADR-0129). Per-user OAuth does not suit unattended runs. MCP fits the interactive side, where a
session writes factory-ready tickets.

## Consequences

Positive:

- One contract for #3459 to #3463 to build against.
- GitHub behavior, branches and state are unchanged, and no state migration is needed.

Negative:

- The queue, lanes, supervisor and claims remain GitHub-only.
- `issue` lingers in `--json` until #3464.
- ADF conversion is lossy.
- Jira status hygiene depends on team-owned automation.
