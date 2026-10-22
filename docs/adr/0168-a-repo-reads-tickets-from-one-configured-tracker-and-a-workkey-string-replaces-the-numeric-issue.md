# ADR-0168: A repo reads tickets from one configured tracker, and a WorkKey string replaces the numeric issue

- Status: Accepted
- Date: 2026-10-22
- Issue: #3458
- Relates to: [ADR-0030](0030-a-closed-target-issue-is-skipped-before-any-resource-is-committed-and-the-skip-is-not-a-park.md), [ADR-0042](0042-one-factory-config-json-two-disjoint-key-namespaces-owned-by-two-loaders.md), [ADR-0044](0044-claiming-a-queued-issue-is-a-label-cas-verified-by-re-fetch-and-the-smallest-claimant-id-wins.md), [ADR-0108](0108-queuebackend-is-a-narrow-4-method-seam-adapted-from-githubqueue-rather-than-replacing-it.md), [ADR-0119](0119-one-repo-config-file-yaml-preferred-json-still-read.md), [ADR-0129](0129-issue-bodies-reach-plan-and-build-only-inside-an-untrusted-issue-body-block-with-a-do-not-follow-notice.md), [ADR-0147](0147-size-gate-slice-mode-ships-an-oversized-issue-as-sequential-slice-prs-under-the-same-issue-instead-of-filing-sub-issues.md), [ADR-0156](0156-size-gate-slice-mode-never-files-sub-issues-an-over-cap-slice-plan-is-recorded-and-parks-and-the-slice-cap-is-configurable.md), [ADR-0167](0167-readiness-is-a-model-judged-three-way-verdict-and-plan-never-rewrites-the-ticket.md)

## Context

The factory reads only GitHub issues. `factory run-issue` takes a bare number (`packages/cli/src/cli/index.ts`). That numeric `issue` is the identity for branches (`factory/<n>-<slug>`), worktrees, events, state and the `--json` contract. SHIP writes `Closes #N` in the PR.

ADR-0108 defined `QueueBackend` but only names other backends as future. Teams on Jira, and later Linear, cannot use the factory today.

The design was settled in a grill on 2026-10-21. ADR-0167 removed the heading-based readiness check, which made non-Markdown bodies unservable. This ADR records the tracker-source decisions so the follow-up issues (#3459 to #3465) build against one text.

## Decision

1. **Scope of v1 is single runs.** `run-issue` and `ship` fetch from the configured tracker and run PLAN through SHIP. The PR links the ticket. Park and failure comments go to the ticket. Queue, lanes, supervisor, claims (ADR-0044), decompose and ingest stay GitHub-only and refuse to start when `tracker.kind` is not `github`. A tracker-backed queue through ADR-0108's `QueueBackend` needs its own ADR.
   - Rejected: a tracker-backed queue in v1.

2. **Identity: a `WorkKey` replaces `issue: number`** in core and CLI.
   - Rejected: a synthetic number in a reserved band (the run-brief trick, `briefRunNumber` in `packages/cli/src/cli/index.ts`). It hides the real key and collides across trackers.

3. **WorkKey shape: a branded native display key with no tracker prefix** (`"123"`, `"PROJ-123"`). A repo has one tracker, so GitHub keys render exactly as today. Branches stay `factory/123-title` and no on-disk state migrates. The stable id (Jira numeric `id`, Linear UUID) lives in `WorkRequest.reference`. A ticket moved to another project is a new work item.
   - Rejected: a tracker-qualified string (`jira:PROJ-123`). It changes every GitHub branch and state path.
   - Rejected: a structured object. Every log line, path and JSON field would need a render step.

4. **The `--json` contract stays v1 and changes additively.** Add `workKey: string`. Keep `issue: number | null` (a number under GitHub, `null` otherwise) as deprecated. Removal is #3464.
   - Rejected: a v2 contract bump now.

5. **Closing is the tracker's own integration's job.** The adapter supplies `closesTrailer(key, isFinalSlice)`. GitHub gives `Closes #N` or `Part of #N`, which keeps the ADR-0147 and ADR-0156 slice behaviour. Jira and Linear give `Closes KEY` or `Part of KEY`. The key goes in the branch, PR title and PR body. The factory never transitions Jira statuses. Teams use the Jira GitHub app or Automation rules.
   - Rejected: the factory transitioning statuses through the Jira API. It is workflow-specific and needs write scopes.

6. **Config.** A runtime-namespace key `tracker` (ADR-0042), added to `FACTORY_RUNTIME_CONFIG_KEYS` in `packages/core/src/config/` and read from the one repo config file (ADR-0119). Fields: `kind: github | jira | linear` (default `github`) and `jira: { baseUrl, projectKeys, acceptanceCriteriaField? }`. Secrets come from env only: `JIRA_EMAIL` and `JIRA_API_TOKEN` (`LINEAR_API_KEY` later). Preflight fails fast when they are missing. `projectKeys` is an allowlist. Jira Cloud only in v1.
   - Rejected: secrets in the config file.
   - Rejected: Jira Server and Data Center in v1.

7. **Ticket body.** Jira ADF converts to plain text or light Markdown. The conversion is lossy on purpose, because readiness is a model judgment (ADR-0167). The optional acceptance-criteria custom field is appended as plain context. The body still enters PLAN and BUILD only inside the untrusted block (ADR-0129). The body is never written back.
   - Rejected: a faithful ADF to Markdown round-trip.
   - Rejected: writing enriched sections back.

8. **CLI input.** Each adapter has `parseKey(input)`. GitHub accepts `123`, `#123`, or an issue URL for this repo. Jira accepts `PROJ-123` (case-insensitive, normalized to upper case) or `<baseUrl>/browse/PROJ-123`. A form from another tracker or host exits 2.
   - Rejected: a `--tracker` override flag.

9. **Writes under a non-GitHub tracker.**
   - Park, env-failure, readiness and slice-plan comments go through `tracker.comment` (the Jira v2 comment endpoint, plain string).
   - Size gate `decompose` and `file` modes are a config error. Only `slice` works (ADR-0147, ADR-0156).
   - Blocker and flaky-test findings become a ticket comment plus an event, never new tickets.
   - PR labels stay on GitHub.
   - A failed comment warns and never fails the run.
   - Rejected: filing new tickets in the tracker.

10. **Closed-ticket skip (ADR-0030).** Jira is closed when `statusCategory.key === 'done'`. Linear is closed when `state.type` is `completed` or `canceled`. Nothing to configure.
    - Rejected: a configurable done-status list.

11. **Testing.** One shared tracker contract suite runs against every adapter, using recorded and sanitized fixtures over a fake HTTP layer. Table tests cover ADF. A `factory tracker check` command checks auth and fetches one ticket. One stub eval case covers a `tracker: jira` run. No live tracker runs in CI.
    - Rejected: live tracker calls in CI.

12. **Jira first; Linear is a planned `kind`.** It is filed as #3465 and built when needed.
    - Rejected: building both adapters at once.

13. **Rejected: reading tickets through a Jira MCP server.** The Node pipeline cannot reach a user's Claude connectors. MCP reads are not deterministic or stub-testable. The Codex harness has no MCP. A model with write access reading an untrusted body is a prompt-injection path (ADR-0129). Per-user OAuth does not suit unattended runs. MCP fits the interactive side, where a session writes factory-ready tickets.

## Consequences

Positive:

- Jira teams are served for single runs.
- GitHub is unchanged on disk and in branch names.
- `--json` consumers are unaffected.

Negative:

- The WorkKey migration touches much of core and CLI.
- Queue mode is unavailable for non-GitHub repos until a later ADR.
- The deprecated `issue` field lingers until #3464.
- Status transitions depend on team-side automation.

Follow-up chain: #3459, then #3460, #3461, #3462, then #3463 (which also needs #3457). Then #3464 (remove the deprecated `issue` field) and #3465 (Linear adapter).

## Alternatives considered

Each decision above lists the alternative it rejected. The main ones are a synthetic issue number, a tracker-qualified or structured key, the factory transitioning Jira statuses, a tracker-backed queue in v1, and reading tickets through an MCP server.
