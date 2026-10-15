# Recorded agent fixtures

These are fake `codex`, `opencode`, `pi` and `command-agent` CLIs used by the smoke tests (#2407). Each shim in `bin/` replays a recording from `recordings/<agent>/`. In success mode it also makes a real commit in the worktree. Put `bin/` first on `PATH` to use them.

## Layout

- `bin/<agent>`: the shim. POSIX sh. Sources `lib/replay.sh`.
- `lib/replay.sh`: shared helpers `fake_mode`, `fake_replay`, `fake_commit` and `fake_drain_stdin`.
- `sentinel/claude`: recording `claude` stand-in that always fails. See Claude sentinel below.
- `lib/claude-sentinel.sh`: `claude_sentinel_check <log>`, the assertion for the sentinel.
- `recordings/<agent>/<mode>.stdout`: replayed to stdout. An optional `<mode>.stderr` is replayed to stderr.
- `recordings/codex/success.last-message`: copied to the `-o <file>` path in success mode.
- `agents.test.ts`: checks every shim and mode, that `classifyFailure` classifies the recorded rate-limit and usage-cap output, and that this README covers every recorded agent.

## Modes

Set `FAKE_AGENT_MODE` to choose a mode. The default is `success`.

| Mode         | Exit | Commit | Output                                              |
| ------------ | ---- | ------ | --------------------------------------------------- |
| `success`    | 0    | yes    | `success.stdout`                                    |
| `rate-limit` | 1    | no     | `rate-limit.stdout` and `.stderr`                   |
| `usage-cap`  | 1    | no     | `usage-cap.stdout` and `.stderr`                    |
| `empty`      | 0    | no     | `empty.stdout` (codex also truncates the `-o` file) |

Any other value exits 2 with `unknown FAKE_AGENT_MODE`.

## Claude sentinel

A non-Claude adapter smoke run must never shell out to `claude`. `sentinel/claude` is a fake `claude` that appends one line (`claude <args>`) to `$CLAUDE_SENTINEL_LOG`, prints `claude sentinel invoked` to stderr and exits 1. With the variable unset it still exits 1, so a call is never silent. It lives outside `bin/` so a caller can put only one agent shim on PATH.

```sh
export CLAUDE_SENTINEL_LOG="$TMP/claude-sentinel.log"
PATH="$ROOT/scripts/fixtures/agents/sentinel:$ROOT/scripts/fixtures/agents/bin/<agent>...:$PATH"
. "$ROOT/scripts/fixtures/agents/lib/claude-sentinel.sh"
claude_sentinel_check "$CLAUDE_SENTINEL_LOG"
```

`claude_sentinel_check` returns 0 when the log is missing or empty, and returns 1 (printing the recorded calls) otherwise.

## Recorded agents

### codex

Version: codex-cli 0.155.1

Captured with: `codex exec --json --sandbox danger-full-access -c approval_policy=never -C <worktree> -o <file> -`

Files: `success.stdout`, `success.last-message`, `rate-limit.stdout`, `usage-cap.stdout`, `empty.stdout`.

#### Refresh codex

1. Run `codex --version` and note the version.
2. In a scratch git repo, pipe a small prompt into the command above, with `> success.stdout`. Copy the `-o` file to `success.last-message`.
3. For `empty`, use a prompt that asks for no reply. For `rate-limit` and `usage-cap`, keep the JSONL of a real failing run if you have one. Otherwise edit the `error` and `turn.failed` message text and keep the event shape from the new version.
4. Normalise: keep the `thread.started`, `turn.*` and `item.completed` events the factory reads, drop the rest, and keep one fixed `thread_id`.
5. Overwrite the files in `recordings/codex/` and update the Version line above.
6. Run `npx vitest run scripts/fixtures/agents/agents.test.ts` from the repo root.

### opencode

Version: opencode 1.18.28

Captured with: `opencode run --auto --format json` (prompt on stdin).

Files: `success.stdout`, `rate-limit.stdout`, `usage-cap.stdout`, `empty.stdout`.

#### Refresh opencode

1. Run `opencode --version` and note the version.
2. In a scratch git repo, pipe a small prompt into the command above, with `> success.stdout`.
3. For `empty`, use a prompt that asks for no reply. For `rate-limit` and `usage-cap`, keep the output of a real 429 or 403 `usage_limit` response if you have one. Otherwise hand-edit the error text and keep the event shape from the new version.
4. Normalise: set every `timestamp` to `1700000000000` and every `sessionID` to `ses_fixture`. Keep the `TOOL_CHATTER_MARKER` tool_use line and the `FINAL ANSWER:` text that the tests rely on.
5. Overwrite the files in `recordings/opencode/` and update the Version line above.
6. Run `npx vitest run scripts/fixtures/agents/agents.test.ts` from the repo root.

### pi

Version: pi 0.1.0 (synthesized, not captured from a real pi)

Only `--version` and `auth check` are recorded, from the output contract in `packages/core/src/models/pi-auth.ts`. Run modes are not recorded.

Files: `version.stdout`, `auth-check.stdout`.

#### Refresh pi

1. Run `pi --version` and save the output to `recordings/pi/version.stdout`.
2. With a zero-data-retention OpenRouter key in `OPENROUTER_API_KEY`, run `pi auth check --model openrouter/deepseek/deepseek-v4.1-flash --no-refresh` and save the output to `recordings/pi/auth-check.stdout` (the first line must be `ready`).
3. Update the Version line above.
4. Run `npx vitest run scripts/fixtures/agents/agents.test.ts` from the repo root.

### command-agent

Version: none, because there is no upstream CLI. The recordings are synthetic and follow the built-in `command` harness contract in `docs/models.md` ("Declaring a custom harness"): `prompt: stdin`, `output: stdout`, `usage: jsonl`, with errors on stderr.

Files: `success.stdout`, `empty.stdout`, `rate-limit.stdout` and `.stderr`, `usage-cap.stdout` and `.stderr`.

#### Refresh command-agent

1. Read "Declaring a custom harness" in `docs/models.md` for any contract change.
2. Edit the JSONL in `success.stdout` so each `usage` object still carries `input_tokens` and `output_tokens`.
3. Keep the stderr text matching the built-in rate_limit and usage_cap rules (`classifyFailure`).
4. Update the Version line with the factory commit you checked against.
5. Run `npx vitest run scripts/fixtures/agents/agents.test.ts` from the repo root.

## Provenance

The recordings are trimmed and normalised. They are not raw byte-for-byte captures. The Version line names the CLI version whose output shape the recording matches. That is the version in `docs/agents.md` under "Version tested". Bump both together.

Refreshing is manual. No script or CI job re-records these files.
