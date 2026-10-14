# Harness adapter contract

A **harness** is the provider adapter that runs a model: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, `opencode`, `command` (runs a harness declared under `harnesses:`), plus `stub` in tests. This page specifies what the factory sends a harness, what it must return, how failures are classified, and what each phase expects. It describes current behavior only.

The source of truth is [`packages/core/src/harness/index.ts`](../packages/core/src/harness/index.ts). Failure classification lives in [`harness/classify.ts`](../packages/core/src/harness/classify.ts). The executable conformance kit is [`harness/contract.ts`](../packages/core/src/harness/contract.ts) (`codingHarnessContractCases`). Routing, effort and failover configuration are in [models.md](./models.md).

## The interface

A `CodingHarness` has three members:

- `id`: a stable string such as `claude-cli`.
- `agentic`: `true` when the harness can edit files in the worktree. Build tasks (`AGENTIC_BUILD_TASKS`: `build_codex`, `build_claude`, `build_opencode`) require an agentic harness; see `taskRequiresAgenticHarness`. Prompt-only harnesses such as `ollama-http` are rejected for builds.
- `run(request): Promise<HarnessResult>`.

## Inputs (`HarnessRequest`)

| Field            | Meaning                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`          | Registry model id (a key in the models config), not the provider-native id. The harness resolves provider flags and ids through `registry`.                                                                                                                                                                                             |
| `prompt`         | The full prompt text. It can contain untrusted issue text. The contract kit runs injection fixtures and requires the harness to either return a string or reject with a classified `HarnessError`.                                                                                                                                      |
| `worktree`       | Absolute path the harness may operate in (the cwd for agentic harnesses).                                                                                                                                                                                                                                                               |
| `timeoutSeconds` | Wall-clock budget. On expiry the harness must kill the child and reject with `timeout`.                                                                                                                                                                                                                                                 |
| `task`           | The `TaskType` (for example `plan`, `build_codex`). Used for effort lookup and agentic gating.                                                                                                                                                                                                                                          |
| `registry`       | The `ModelRegistry`. Effort is not a request field: the harness reads it with `registry.getEffort(model, task)`. `claude-cli.ts`, for example, passes `--effort` and sets `CLAUDE_CODE_EFFORT_LEVEL`. `undefined` means the provider default. See the effort section of [models.md](./models.md).                                       |
| `env`            | Optional extra child environment variables (for example the lane's `PORT` lease), merged over the parent env.                                                                                                                                                                                                                           |
| `sandbox`        | Optional `SandboxPolicy` ([`sandbox/index.ts`](../packages/core/src/sandbox/index.ts)): `runtime` (`sandbox-exec`, `firejail`, `docker-sandbox`, `none`), `worktree`, `writablePaths`, `writableFilePrefixes`, `allowHosts`, optional `proxyUrl`, `cpuMs`, `memMb`. When set, the harness wraps its CLI invocation in that containment. |
| `onPgid`         | Optional callback. When set, the child is spawned detached in its own process group and its pid is reported so the lane can kill the whole group later.                                                                                                                                                                                 |

## Outputs (`HarnessResult`)

- `output` (required): the final text, always non-empty after trim. Empty provider output must reject with `empty_response`; it must never resolve `''`. Callers must propagate that rejection.
- `usage` (optional, `HarnessUsage`): only real provider-reported numbers. Fields: `inputTokens` (all input-side tokens including cache read and creation), `outputTokens`, and optional `rawInputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `numTurns`, `durationMs`, `durationApiMs`, `costUsd`. Usage feeds `.factory/costs.jsonl` (`factory cost`). Never invent numbers; omit `usage` when it cannot be parsed.

## Failures

Every failure must reject with `HarnessError(message, reason, details)`. The message must be non-empty (the contract kit checks this). `details` may carry `exitCode`, `stderr`, `stdout`, `diagnostic`, `code`, `signal` and `killed`.

`reason` is one of the 11 `HarnessFailureReason` values below. `classifyFailure(stderr, exitCode)` maps provider output to a reason; the patterns are matched case-insensitively and in the order listed here. A declared `command` harness can select the reason itself with `errorPatterns` (see [models.md](./models.md)); a timeout still wins.

| Reason           | Meaning                                  | Detected by `classifyFailure`                                                                                                                   | Retryable |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `timeout`        | Exceeded `timeoutSeconds`.               | Exit code 124.                                                                                                                                  | yes       |
| `local_auth`     | Local CLI login expired or failed.       | "failed to authenticate", "oauth session expired", "could not be refreshed", "please login".                                                    | yes       |
| `rate_limit`     | Provider throttling.                     | "rate limit", "too many requests", or 429 in an HTTP, status, response or retry-after context.                                                  | yes       |
| `usage_cap`      | Quota, plan or billing cap reached.      | usage, plan, monthly, weekly or daily limit; "usage cap"; quota; billing; insufficient quota or credits; "limit ... resets".                    | yes       |
| `empty_response` | No usable output.                        | "empty", "no content", "no response", or output that is empty after trim.                                                                       | yes       |
| `schema_invalid` | Output did not match the required shape. | "schema invalid" / "schema_invalid".                                                                                                            | no        |
| `apply_failed`   | A patch could not be applied.            | "apply failed" / "apply_failed".                                                                                                                | no        |
| `verify_failed`  | Verification of the result failed.       | "verify failed", "verification failed".                                                                                                         | no        |
| `error`          | Any other failure.                       | "error", "fail" or "exception" in the text.                                                                                                     | yes       |
| `unknown`        | Nothing matched.                         | Fallthrough.                                                                                                                                    | yes       |
| `unavailable`    | Provider unreachable.                    | Not produced by `classifyFailure`; a harness sets it directly. `claude-cli` does so for an error result with zero tokens and zero API duration. | yes       |

`schema_invalid`, `apply_failed` and `verify_failed` are `NON_RETRYABLE_FAILURE_REASONS`: they are deterministic, so `isRetryableFailure` returns `false` and the router does not fail over to another model.

### How the factory reacts

The router's failover reads `err.reason`. The configured failover triggers (table in [models.md](./models.md)) default to `rate_limit`, `usage_cap`, `timeout`, `error` and `empty_response`. `rate_limit`, `usage_cap`, `timeout`, `unavailable` and `local_auth` are treated as provider or external faults: BUILD may switch from the claude route to a codex worker (`phases/build.ts`), and CHECK classifies them as external through the `EXTERNAL_REASONS` set in `phases/check.ts`.

## Per-phase expectations

### PLAN

The harness runs in the lane worktree and must write exactly one spec file at the path named in the prompt. The file has YAML frontmatter with `route:` (`codex`, `claude` or `opencode`) and a machine-validated `design:` block whose keys must match the template in the prompt. PLAN does not implement anything. If the repo pins a build worker, its harness overrides the route after PLAN (`packages/core/src/phases/plan.ts`).

### BUILD

BUILD needs an agentic harness. It leaves local commits in the lane worktree. BUILD does not push the branch, open or update a PR, or wait on CI (ADR-0138); SHIP is the only phase that publishes. The one exception is the opt-in `build.publishFromBuild` setting (`FACTORY_BUILD_PUBLISH=1`) on the claude route. The returned text is a summary and must still be non-empty.

### CHECK

Model-judged checkers (for example `lens_review`, `design_smells`, `regression_hunt`) run a harness and parse a verdict or findings from the returned text. Malformed output is a checker failure, and lens errors fail closed (ADR-0158). Rework rounds re-run BUILD with the failures.

### Review

Review calls such as the PR classifier ([`review/classifier.ts`](../packages/core/src/review/classifier.ts)) ask for a JSON verdict (`class` of `A`, `B` or `C`, with cited `claims`) and validate it against a schema. The classifier never throws: an unparseable or invalid verdict is recorded as no model class and does not crash the run.

## Usage watchdog

Only `claude-cli` has a usage signal (the Anthropic subscription window, or the opt-in transcript estimator). `factory run` decides which harness the run uses: when the effective build route is `codex` or `opencode` and the plan pin (plus `planFallback`) is a non-Claude model, the run's harness is `codex-cli` or `opencode`. The watchdog then logs one `usage-unavailable` event, "usage watchdog not available for this agent (<harness>)", and does not gate the run on Claude usage.

Every other case keeps Claude gating, including an unpinned plan, a Claude plan pin, an unknown route and local-only runs. Auxiliary Claude calls (checker, triage) in a non-Claude run are not gated by the watchdog.

## Testing a harness

To test a CLI declared under `harnesses:`, run `factory harness check <id>`. No code is needed (see [Bring your own agent](./agents.md#bring-your-own-agent)).

For an in-repo adapter, implement `HarnessContractScenarios` (`success`, `timeout`, `emptyOutput`, `failure`), each returning the harness under test plus optional request overrides. Register `codingHarnessContractCases(...)` in a vitest file; the existing `packages/core/src/harness/*.test.ts` files show examples. Run them with:

```bash
npx vitest run packages/core/src/harness
```
