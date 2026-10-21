# Steer events

A steer is one human or bot intervention on a factory run. It is appended to the run's `steers`
array in `state/runs/issue-<n>.json` (default state root `.factory/state/runs/`) and counted by
`factory report --steerability` as steers_per_merged_pr, by lane and ISO week.

## Emit a steer with `factory steer`

```sh
# A human steer on issue 3404 (source defaults to cli, actor to git user.name then $USER)
factory steer 3404 --message "use the new API"

# A bot handoff: source bot needs an explicit actor
factory steer 3404 --message "Beckett: switch BUILD to the v2 client" --source bot --actor beckett-bot

# By PR number or URL, marking that the steer unblocked a stuck run
factory steer https://github.com/on-par/software-factory/pull/3406 --message "rebase on main" --unblocked
```

- `<ref>`: issue or PR number (`42`, `#42`) or a GitHub `/issues/<n>` or `/pull/<n>` URL. A bare
  number matches the issue's run first, then a run whose PR has that number.
- `--message <text>` (required, non-empty): becomes `summary`.
- `--source <cli|bot|github-comment>` (default `cli`). Bots use `bot`.
- `--phase <plan|build|check|ship>` (default: derived from the run's current status).
- `--actor <id>` (default git `user.name`, then `$USER`; required with `--source bot`).
- `--unblocked`: sets `unblocked: true`.
- Exit codes: 0 recorded; 1 no run matches the reference; 2 bad input (empty message, unknown
  source or phase). Nothing is written on error.

## Event fields

| Field       | Type                                   | Rule                                                         |
| ----------- | -------------------------------------- | ------------------------------------------------------------ |
| `ts`        | string                                 | ISO-8601 datetime with offset                                |
| `actor`     | string                                 | non-empty; see the actor identity decision                   |
| `source`    | `cli` \| `bot` \| `github-comment`     | closed list `STEER_SOURCES`                                  |
| `phase`     | `plan` \| `build` \| `check` \| `ship` | closed list `STEER_PHASES`                                   |
| `summary`   | string                                 | non-empty, one line                                          |
| `unblocked` | boolean, optional                      | true when the steer unblocked a stuck run; omit when unknown |

Unknown keys are rejected (strict schema). Events are append-only: there is no update or delete
API. One stored event:

```json
{
  "ts": "2026-10-21T09:00:00Z",
  "actor": "beckett-bot",
  "source": "bot",
  "phase": "build",
  "summary": "switch BUILD to the v2 client"
}
```

Writing the run file directly is possible but not recommended. Prefer `factory steer`, which
validates the event and does not race the run recorder.

## Rules

- Capture is **opt-in** emit only. A steer exists only when a person or bot runs `factory steer`
  (or appends a valid event). The factory never scrapes or ingests chat, bot, or agent transcripts
  (Grok Bot, Beckett/Cooper chats, Claude Code, Codex). Emit one line per intervention; the chat
  receipt stays in chat.
- **Do not hide steers to improve the score.** Every intervention that changed what a run did
  should be recorded, one event per intervention. Do not skip, batch, delete, or route steers
  outside the factory to lower steers_per_merged_pr. The number is driven down by better skills
  and specs (the Grade loop), not by under-reporting.

## Decisions

Open questions from parent issue #3361, recorded in #3404.

### GitHub `/factory steer` comments in v1

Status: Deferred. v1 captures CLI and bot emit only. The `github-comment` source is already in
`STEER_SOURCES`, so a later comment parser needs no schema change. Parsing PR comments is not
implemented. Revisit once CLI and bot emit volume shows whether reviewers steer through PR
comments.

### PLAN-phase clarification counts

Status: Resolved. Steers in every phase count, including PLAN clarification. A PLAN clarification
is still a human intervention, and excluding it would reward moving steering earlier instead of
removing it. Every event records `phase`, so a per-phase breakdown can be added later without
losing data. This matches `collectMergedPrSteers` (`packages/core/src/kpis/steerability.ts`),
which counts every steer in a PR's merge window regardless of phase.

### Trust-tier demotion on high steer count

Status: Deferred. Steer count does not change a merge trust tier in v1 and nothing implements it.
Tier changes follow ADR-0144 and ADR-0148 (promotion only by a human-merged policy change on
published evidence; demotion on a slip). Whether a high steer count is a slip (#1959) is decided
later, through that ADR process, once steers_per_merged_pr has enough history to set a threshold.

### Actor identity format

Status: Resolved. `actor` is free text, stored as given and never normalised (see the
`SteerEvent.actor` comment in `packages/core/src/run/steer.ts`). Convention: a GitHub login for
`github-comment` and `bot` sources (a bot uses its GitHub app/bot login or a stable agent id such
as `beckett-bot`), and git `user.name` then `$USER` for `cli`. Free text keeps stored events valid
if the format is refined later, with no migration.
