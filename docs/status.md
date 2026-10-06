# Status

Honest snapshot of what works today vs. what is experimental. Statuses reflect the actual code, not the roadmap.

| Feature                                               | Status          | Notes                                                                                                                                                                           |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory ship` pipeline (PLAN → BUILD → CHECK → SHIP) | ✅ Working      | Covered by an end-to-end pipeline integration test                                                                                                                              |
| `factory triage` (queue from open issues)             | ✅ Working      |                                                                                                                                                                                 |
| `factory run` (parallel lanes)                        | ✅ Working      | Merges are serialized per lane via a merge-wait step                                                                                                                            |
| `factory land` / auto-merge                           | ✅ Working      | Auto-merge is **off by default** (`merge.auto: false`); set `FACTORY_MERGE=1` to enable autonomous squash-merge; add `FACTORY_MERGE_ADMIN=1` only when admin bypass is intended |
| `factory supervise` (multi-window unattended runs)    | ✅ Working      | Waits for usage headroom, runs the queue, repeats until drained                                                                                                                 |
| Usage-cap watchdog (`factory usage`, stop-at-cap)     | ✅ Working      | Trailing-5h cost-weighted usage vs. cap (Claude models only); lanes stop at the cap                                                                                             |
| Codex worker builds (`codex exec`)                    | ✅ Working      | Used for the `build_codex` route                                                                                                                                                |
| Claude models via the Claude CLI (`claude -p`)        | ✅ Working      | TRIAGE always shells out to `claude -p`; PLAN routes through the boss tier (local models first, Claude as failover)                                                             |
| Harness dispatch (per-model provider adapters)        | ✅ Working      | Each model declares a `harness` in `defaults.ts`: `claude-cli`, `codex-cli`, `ollama-http`, `ollama-agentic`, `opencode`                                                        |
| GPT worker models via the Codex CLI                   | ✅ Working      | `gpt-5.6-terra` (plan=high / build=medium) → `gpt-5.6-sol` → `gpt-5.1-codex`, dispatched through the `codex-cli` harness                                                        |
| Local Ollama + OpenCode models                        | ⚠️ Experimental | Harnesses are contract-tested, but real-run behavior is unverified — expect failover to a cloud model                                                                           |
| DeepSeek / gpt-4.1-mini via `claude --model ...`      | ⚠️ Experimental | The Claude CLI only serves Anthropic models; this wiring is unproven                                                                                                            |
| Prompt evals (`npm run eval`)                         | ✅ Working      | Deterministic stub subset runs in CI on every PR; weekly real run checks prompt/constitution/skill regressions under pinned model IDs                                           |
| Cost tracking (`factory cost`)                        | ✅ Working      | Per-task tokens and cost logged to `.factory/costs.jsonl`                                                                                                                       |
| Constitutions + checker rework loop                   | ✅ Working      | Up to 3 rework rounds with dispute resolution                                                                                                                                   |
| Server (`packages/server`)                            | ✅ Working      | Loopback `GET /events` relays the lane lifecycle bus as SSE, `Last-Event-ID` resume via a bounded replay ring — no auth, no control endpoints yet                               |

See the [README](../README.md) for Quick Start.
